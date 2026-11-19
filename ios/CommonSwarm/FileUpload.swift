import Combine
import CryptoKit
import Foundation

enum AttachmentError: LocalizedError {
    case type, size, count, placement, transfer
    var errorDescription: String? {
        switch self {
        case .type: "This file type isn’t supported."
        case .size: "Choose a nonempty file of 25 MiB or less."
        case .count: "A message can include up to eight files."
        case .placement: "Files require a confirmed open channel."
        case .transfer: "The file transfer couldn’t be confirmed."
        }
    }
}

struct FileReference: Codable {
    let file_id: UUID
    let version_n: Int
}

final class StagedFile: Identifiable, Sendable {
    let id = UUID()
    let versionID = UUID()
    let createID = UUID()
    let commitID = UUID()
    let name: String
    let type: String
    let url: URL
    let size: Int
    let digest: String

    static let limit = 25 * 1024 * 1024
    static let types = ["txt":"text/plain","md":"text/markdown","csv":"text/csv","html":"text/html","htm":"text/html",
                        "json":"application/json","yaml":"application/yaml","yml":"application/yaml","pdf":"application/pdf",
                        "docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        "jpg":"image/jpeg","jpeg":"image/jpeg","png":"image/png","gif":"image/gif","webp":"image/webp",
                        "svg":"image/svg+xml","zip":"application/zip","tar.gz":"application/gzip",
                        "mp4":"video/mp4","mov":"video/quicktime"]

    init(data: Data, name: String) throws {
        guard (1...Self.limit).contains(data.count) else { throw AttachmentError.size }
        let ext = name.lowercased().hasSuffix(".tar.gz") ? "tar.gz" : (name as NSString).pathExtension.lowercased()
        guard let type = Self.types[ext], name.count <= 255, let first = name.first, first != ".", !first.isWhitespace,
              !name.contains("/"), !name.contains("\\"), name.rangeOfCharacter(from: .controlCharacters) == nil else { throw AttachmentError.type }
        self.name = name
        self.type = type
        size = data.count
        digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        url = FileManager.default.temporaryDirectory.appending(path: "commonswarm-upload-" + id.uuidString)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    convenience init(source: URL, name: String? = nil) throws {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, (1...Self.limit).contains(values.fileSize ?? 0) else { throw AttachmentError.size }
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        var data = Data()
        while let block = try handle.read(upToCount: 65536), !block.isEmpty {
            guard data.count + block.count <= Self.limit else { throw AttachmentError.size }
            data.append(block)
        }
        try self.init(data: data, name: name ?? source.lastPathComponent)
    }
    deinit { try? FileManager.default.removeItem(at: url) }
}

@MainActor
final class UploadIntent: ObservableObject, Identifiable {
    let file: StagedFile
    nonisolated let id: UUID
    init(file: StagedFile) { self.file = file; id = file.id }
    fileprivate var slot: UploadSlot?
    fileprivate var uploaded = false
    fileprivate var committed: FileReference?
    @Published fileprivate(set) var fraction: Double = 0
}

private struct UploadSlot: Decodable {
    let status: String
    let file_id, version_id: UUID
    let version_n: Int
    let upload_path: String
}

private final class UploadProgress: NSObject, URLSessionTaskDelegate {
    let changed: @Sendable (Double) -> Void
    init(_ changed: @escaping @Sendable (Double) -> Void) { self.changed = changed }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { changed(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend))) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

private struct FileEnvelope<Command: Encodable>: Encodable {
    let command_id, workspace_id: UUID
    let stream = ["kind": "workspace"]
    let command: Command
}

extension ConversationAPI {
    @MainActor
    func upload(_ intent: UploadIntent, workspace: UUID, destination: Conversation.Destination) async throws -> FileReference {
        if let ref = intent.committed { return ref }
        if case let .channel(channel, _) = destination {
            struct Placement: Decodable { let visibility: String }
            let placement: [Placement] = try await rows("channels", ["select":"visibility","workspace_id":"eq." + workspace.uuidString,
                "channel_id":"eq." + channel.uuidString,"archived_at":"is.null"])
            guard placement.count == 1, placement[0].visibility == "open" else { throw AttachmentError.placement }
        }
        struct Create: Encodable {
            let kind = "file_version_create"
            let file_id, version_id: UUID
            let name, content_type: String
            let declared_size_bytes: Int
        }
        struct Commit: Encodable {
            let kind = "file_version_commit"
            let file_id, version_id: UUID
            let sha256: String
        }
        struct Committed: Decodable { let status: String; let file_id: UUID; let version_n, size_bytes: Int }
        let file = intent.file
        let slot: UploadSlot
        if let existing = intent.slot { slot = existing }
        else {
            slot = try await fileCommand(file.createID, workspace, Create(file_id: file.id, version_id: file.versionID,
                name: file.name, content_type: file.type, declared_size_bytes: file.size))
            guard slot.status == "accepted", slot.version_id == file.versionID, slot.version_n > 0 else { throw AttachmentError.transfer }
            intent.slot = slot
        }
        if !intent.uploaded {
            let expected = "/storage/v1/object/upload/sign/swarm-files/" + workspace.uuidString.lowercased() + "/" + slot.file_id.uuidString.lowercased() + "/" + String(slot.version_n)
            guard let path = URLComponents(string: slot.upload_path), path.scheme == nil, path.host == nil, path.fragment == nil,
                  path.percentEncodedPath == expected, path.queryItems?.contains(where: { $0.name == "token" && $0.value?.isEmpty == false }) == true,
                  let url = URL(string: slot.upload_path, relativeTo: origin)?.absoluteURL else { throw AttachmentError.transfer }
            var req = URLRequest(url: url)
            req.httpMethod = "PUT"
            req.httpShouldHandleCookies = false
            req.setValue(file.type, forHTTPHeaderField: "Content-Type")
            let status = try await session.putStorage(req, from: file.url, delegate: UploadProgress { progress in
                Task { @MainActor in intent.fraction = progress }
            })
            // If a previous PUT succeeded but its receipt was lost, commit checks the stored object.
            intent.uploaded = (200..<300).contains(status)
        }
        let result: Committed = try await fileCommand(file.commitID, workspace,
            Commit(file_id: slot.file_id, version_id: slot.version_id, sha256: file.digest))
        guard result.status == "accepted", result.file_id == slot.file_id, result.version_n == slot.version_n,
              result.size_bytes == file.size else { throw AttachmentError.transfer }
        let ref = FileReference(file_id: result.file_id, version_n: result.version_n)
        intent.committed = ref
        intent.fraction = 1
        return ref
    }

    private func fileCommand<C: Encodable, R: Decodable>(_ id: UUID, _ workspace: UUID, _ command: C) async throws -> R {
        var req = request("functions/v1/command")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(FileEnvelope(command_id: id, workspace_id: workspace, command: command))
        return try await send(req)
    }
}
