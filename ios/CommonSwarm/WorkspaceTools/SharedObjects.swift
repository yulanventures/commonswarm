import Combine
import Foundation

enum SharedObjectKind: String, Codable, Hashable, Sendable {
    case list
    case doc
    case file
    case definition

    var isListOrDoc: Bool { self == .list || self == .doc }

    var label: String {
        switch self {
        case .list: "List"
        case .doc: "Doc"
        case .file: "File"
        case .definition: "Definition"
        }
    }

    var symbolName: String {
        switch self {
        case .list: "checklist"
        case .doc: "doc.text"
        case .file: "doc"
        case .definition: "book"
        }
    }
}

enum SharedObjectsFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case lists
    case docs

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All"
        case .lists: "Lists"
        case .docs: "Docs"
        }
    }
}

enum SharedContentRole: String, Decodable, Hashable, Sendable {
    case reader
    case editor

    var label: String {
        switch self {
        case .reader: "Reader"
        case .editor: "Editor"
        }
    }
}

struct SharedAccess: Equatable, Sendable {
    let role: SharedContentRole
    let operations: Set<String>

    var canRead: Bool { operations.contains("read") }
    var canUpdate: Bool { role == .editor && canRead && operations.contains("update") }
    var canCreate: Bool { role == .editor && canRead && operations.contains("create") }
}

enum SharedAccessStatus: Equatable, Sendable {
    case granted(SharedAccess)
    case needsConfirmation(reason: String)
    case refused(reason: String)
}

struct SharedRevisionRef: Codable, Hashable, Sendable {
    let workspace_id: String
    let object_id: String
    let token: String

    func isBound(workspaceID: UUID, objectID: String) -> Bool {
        workspace_id.lowercased() == workspaceID.uuidString.lowercased()
            && object_id == objectID
            && !token.isEmpty
    }
}

struct SharedAttribution: Decodable, Hashable, Sendable {
    let user_id: String
    let principal_id: String?
}

struct SharedListItem: Codable, Hashable, Identifiable, Sendable {
    let item_id: String
    let text: String
    let order: Int
    let checked: Bool

    var id: String { item_id }
}

enum SharedContent: Hashable, Sendable {
    case list([SharedListItem])
    case doc(String)

    var kind: SharedObjectKind {
        switch self {
        case .list: .list
        case .doc: .doc
        }
    }
}

struct SharedObjectSummary: Hashable, Identifiable, Sendable {
    let objectID: String
    let kind: SharedObjectKind
    let title: String
    let revision: SharedRevisionRef

    var id: String { objectID }
}

struct SharedObjectDetail: Hashable, Sendable {
    let objectID: String
    let kind: SharedObjectKind
    let title: String
    let revision: SharedRevisionRef
    let authorLabel: String
    let authorIsAgent: Bool
    let occurredAtServerMs: Int64
    let live: Bool
    let content: SharedContent

    var formattedSavedAt: String {
        guard occurredAtServerMs > 0 else { return "" }
        let date = Date(timeIntervalSince1970: Double(occurredAtServerMs) / 1000.0)
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    var sortedListItems: [SharedListItem] {
        guard case .list(let items) = content else { return [] }
        return items.sorted { $0.order < $1.order }
    }
}

enum SharedListPatchOp: Encodable, Equatable, Sendable {
    case add(itemID: String, text: String, checked: Bool, afterItemID: String?)
    case set(itemID: String, beforeText: String, beforeChecked: Bool, text: String, checked: Bool)
    case remove(itemID: String, beforeText: String, beforeChecked: Bool)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .add(let itemID, let text, let checked, let afterItemID):
            try container.encode("add", forKey: .kind)
            try container.encode(itemID, forKey: .item_id)
            try container.encode(text, forKey: .text)
            try container.encode(checked, forKey: .checked)
            try container.encode(afterItemID, forKey: .after_item_id)
        case .set(let itemID, let beforeText, let beforeChecked, let text, let checked):
            try container.encode("set", forKey: .kind)
            try container.encode(itemID, forKey: .item_id)
            try container.encode(beforeText, forKey: .before_text)
            try container.encode(beforeChecked, forKey: .before_checked)
            try container.encode(text, forKey: .text)
            try container.encode(checked, forKey: .checked)
        case .remove(let itemID, let beforeText, let beforeChecked):
            try container.encode("remove", forKey: .kind)
            try container.encode(itemID, forKey: .item_id)
            try container.encode(beforeText, forKey: .before_text)
            try container.encode(beforeChecked, forKey: .before_checked)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, item_id, text, checked, after_item_id, before_text, before_checked
    }
}

enum SharedSaveOutcome: Equatable, Sendable {
    case committed(revision: SharedRevisionRef)
    case conflict(current: SharedRevisionRef, draftID: String)
    case refused(reason: String, message: String)
    case unconfirmed(message: String)
}

enum SharedMarkdownBlock: Equatable, Identifiable, Sendable {
    case heading(id: Int, level: Int, text: String)
    case bullet(id: Int, text: String)
    case numbered(id: Int, number: String, text: String)
    case codeBlock(id: Int, text: String)
    case paragraph(id: Int, text: String)

    var id: Int {
        switch self {
        case .heading(let id, _, _),
             .bullet(let id, _),
             .numbered(let id, _, _),
             .codeBlock(let id, _),
             .paragraph(let id, _):
            return id
        }
    }
}

enum SharedObjectsRules {
    static let objectLimit = 500

    /// Formats saved-by attribution matching web's householdAttribution without exposing raw UUIDs when names exist.
    static func formatAttribution(
        _ author: SharedAttribution,
        viewerID: UUID,
        userNames: [UUID: String],
        agentNames: [UUID: String]
    ) -> (label: String, isAgent: Bool) {
        let userUUID = UUID(uuidString: author.user_id)
        let personName: String? = userUUID.map { uid in
            uid == viewerID ? "You" : (userNames[uid] ?? "Member")
        }
        if let rawPrincipal = author.principal_id, !rawPrincipal.isEmpty {
            let agentUUID = UUID(uuidString: rawPrincipal)
            let agentName = agentUUID.flatMap { agentNames[$0] } ?? "Agent"
            if let personName {
                if personName == "You" {
                    return ("\(agentName), your agent", true)
                }
                return ("\(agentName), \(personName)’s agent", true)
            }
            return (agentName, true)
        }
        return (personName ?? "Member", false)
    }

    static func refusalMessage(_ reason: String) -> String {
        switch reason {
        case "content_read_only":
            return "This save was refused because you have reader access."
        case "content_consent_required":
            return "Content access needs your confirmation before saving."
        case "workspace_access_refused":
            return "This save was refused because you are no longer a member of this workspace."
        case "storage_quota_reached":
            return "This save was refused because the workspace storage limit is full."
        case "object_quota_reached":
            return "This save was refused because this workspace reached its list and document limit."
        case "object_write_rate_limited":
            return "Too many changes were sent at once. Wait a moment and try again."
        case "object_not_found":
            return "This item is no longer available."
        case "revision_not_found", "patch_base_mismatch":
            return "This list changed since it loaded. Reload it to review."
        case "title_invalid":
            return "That title is not valid."
        default:
            return "This save was refused."
        }
    }

    /// Inert Markdown block parser for shared docs: never executes HTML, never fetches remote URLs, never creates clickable links.
    static func parseInertMarkdown(_ raw: String) -> [SharedMarkdownBlock] {
        let normalized = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [SharedMarkdownBlock] = []
        var nextID = 0
        var paragraphBuffer: [String] = []
        var inCode = false
        var codeBuffer: [String] = []

        func flushParagraph() {
            let joined = paragraphBuffer.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(.paragraph(id: nextID, text: stripInlineMarkdown(joined)))
                nextID += 1
            }
            paragraphBuffer = []
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                if inCode {
                    blocks.append(.codeBlock(id: nextID, text: codeBuffer.joined(separator: "\n")))
                    nextID += 1
                    codeBuffer = []
                    inCode = false
                } else {
                    flushParagraph()
                    inCode = true
                }
                continue
            }
            if inCode {
                codeBuffer.append(line)
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                continue
            }
            if let heading = parseHeading(trimmed) {
                flushParagraph()
                blocks.append(.heading(id: nextID, level: heading.level, text: stripInlineMarkdown(heading.text)))
                nextID += 1
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                flushParagraph()
                let body = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                blocks.append(.bullet(id: nextID, text: stripInlineMarkdown(body)))
                nextID += 1
                continue
            }
            if let numbered = parseNumbered(trimmed) {
                flushParagraph()
                blocks.append(.numbered(id: nextID, number: numbered.number, text: stripInlineMarkdown(numbered.text)))
                nextID += 1
                continue
            }
            paragraphBuffer.append(trimmed)
        }
        if inCode && !codeBuffer.isEmpty {
            blocks.append(.codeBlock(id: nextID, text: codeBuffer.joined(separator: "\n")))
        } else {
            flushParagraph()
        }
        return blocks
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        var hashes = 0
        for ch in line {
            if ch == "#" { hashes += 1 } else { break }
        }
        guard (1...6).contains(hashes) else { return nil }
        let after = line.dropFirst(hashes)
        guard after.first == " " else { return nil }
        let text = after.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (hashes, text)
    }

    private static func parseNumbered(_ line: String) -> (number: String, text: String)? {
        guard let dotIdx = line.firstIndex(of: ".") else { return nil }
        let prefix = line[..<dotIdx]
        guard !prefix.isEmpty, prefix.allSatisfy(\.isNumber) else { return nil }
        let afterDot = line.index(after: dotIdx)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        let text = line[line.index(after: afterDot)...].trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (String(prefix) + ".", text)
    }

    /// Strips basic Markdown emphasis/link syntax into inert plain text so links and HTML remain inert text.
    private static func stripInlineMarkdown(_ text: String) -> String {
        var out = text
        // Convert [label](url) to inert "label" text (no clickable URLs, no fetches)
        if let linkRegex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\(([^)]+)\)"#) {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            out = linkRegex.stringByReplacingMatches(in: out, range: range, withTemplate: "$1")
        }
        out = out.replacingOccurrences(of: "**", with: "")
        out = out.replacingOccurrences(of: "__", with: "")
        return out
    }
}

struct SharedPendingListEdit: Equatable, Sendable {
    let commandID: UUID
    let base: SharedRevisionRef
    let operations: [SharedListPatchOp]
    let pendingNewItemText: String?
}

@MainActor
final class SharedObjectsListStore: ObservableObject {
    @Published var filter: SharedObjectsFilter = .all
    @Published private(set) var accessStatus: SharedAccessStatus?
    @Published private(set) var objects: [SharedObjectSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false

    let workspaceID: UUID

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    var access: SharedAccess? {
        if case .granted(let a) = accessStatus { return a }
        return nil
    }

    var visibleObjects: [SharedObjectSummary] {
        switch filter {
        case .all:
            return objects
        case .lists:
            return objects.filter { $0.kind == .list }
        case .docs:
            return objects.filter { $0.kind == .doc }
        }
    }

    func load(api: SharedObjectsAPI) async {
        isLoading = true
        loadFailed = false
        do {
            let status = try await api.access(workspaceID: workspaceID)
            guard !Task.isCancelled else { return }
            accessStatus = status
            guard case .granted(let access) = status, access.canRead else {
                objects = []
                isLoading = false
                return
            }
            let listed = try await api.listObjects(workspaceID: workspaceID)
            guard !Task.isCancelled else { return }
            objects = listed
        } catch {
            if !Task.isCancelled {
                loadFailed = true
            }
        }
        isLoading = false
    }
}

@MainActor
final class SharedObjectDetailStore: ObservableObject {
    @Published private(set) var detail: SharedObjectDetail?
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isSaving = false
    @Published private(set) var saveBanner: String?
    @Published private(set) var conflictMessage: String?
    @Published private(set) var saveError: String?
    @Published private(set) var pendingEdit: SharedPendingListEdit?
    @Published var newItemText = ""

    let workspaceID: UUID
    let objectID: String
    let expectedKind: SharedObjectKind
    let access: SharedAccess?
    private var bannerTask: Task<Void, Never>?

    init(workspaceID: UUID, objectID: String, expectedKind: SharedObjectKind, access: SharedAccess?) {
        self.workspaceID = workspaceID
        self.objectID = objectID
        self.expectedKind = expectedKind
        self.access = access
    }

    var canEditList: Bool {
        expectedKind == .list && (access?.canUpdate ?? false) && !isSaving && conflictMessage == nil
    }

    func load(api: SharedObjectsAPI) async {
        isLoading = true
        loadFailed = false
        do {
            let loaded = try await api.readObject(workspaceID: workspaceID, objectID: objectID, expectedKind: expectedKind)
            guard !Task.isCancelled else { return }
            detail = loaded
            conflictMessage = nil
            saveError = nil
            pendingEdit = nil
        } catch {
            if !Task.isCancelled {
                loadFailed = true
            }
        }
        isLoading = false
    }

    func toggleItem(_ item: SharedListItem, api: SharedObjectsAPI) async {
        guard canEditList, let current = detail else { return }
        let op = SharedListPatchOp.set(
            itemID: item.item_id,
            beforeText: item.text,
            beforeChecked: item.checked,
            text: item.text,
            checked: !item.checked
        )
        await applyListPatch(
            SharedPendingListEdit(commandID: UUID(), base: current.revision, operations: [op], pendingNewItemText: nil),
            api: api
        )
    }

    func removeItem(_ item: SharedListItem, api: SharedObjectsAPI) async {
        guard canEditList, let current = detail else { return }
        let op = SharedListPatchOp.remove(
            itemID: item.item_id,
            beforeText: item.text,
            beforeChecked: item.checked
        )
        await applyListPatch(
            SharedPendingListEdit(commandID: UUID(), base: current.revision, operations: [op], pendingNewItemText: nil),
            api: api
        )
    }

    func addItem(api: SharedObjectsAPI) async {
        let trimmed = newItemText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canEditList, let current = detail else { return }
        let afterID = current.sortedListItems.last?.item_id
        let op = SharedListPatchOp.add(
            itemID: UUID().uuidString.lowercased(),
            text: trimmed,
            checked: false,
            afterItemID: afterID
        )
        await applyListPatch(
            SharedPendingListEdit(commandID: UUID(), base: current.revision, operations: [op], pendingNewItemText: trimmed),
            api: api
        )
    }

    func retryPendingEdit(api: SharedObjectsAPI) async {
        guard let pendingEdit, !isSaving else { return }
        await applyListPatch(pendingEdit, api: api)
    }

    private func applyListPatch(_ edit: SharedPendingListEdit, api: SharedObjectsAPI) async {
        isSaving = true
        saveError = nil
        conflictMessage = nil
        pendingEdit = edit

        let outcome = await api.updateList(
            workspaceID: workspaceID,
            objectID: objectID,
            base: edit.base,
            operations: edit.operations,
            requestID: edit.commandID
        )
        isSaving = false

        switch outcome {
        case .committed:
            pendingEdit = nil
            if edit.pendingNewItemText != nil {
                newItemText = ""
            }
            // Reload server-confirmed revision (matching web audit U7)
            if let fresh = try? await api.readObject(workspaceID: workspaceID, objectID: objectID, expectedKind: expectedKind) {
                detail = fresh
            }
            showSavedBanner("Saved")
        case .conflict:
            conflictMessage = "Someone saved another revision. Reload to see the current list before trying again."
        case .refused(_, let message):
            saveError = message
        case .unconfirmed(let message):
            saveError = message
        }
    }

    private func showSavedBanner(_ text: String) {
        saveBanner = text
        bannerTask?.cancel()
        bannerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.saveBanner = nil
        }
    }
}
