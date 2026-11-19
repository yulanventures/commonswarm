import ImageIO
import SwiftUI
import UniformTypeIdentifiers

private typealias ViewState<Value> = SwiftUI.State<Value>

private struct AttachmentDocument: FileDocument {
    static let readableContentTypes = [UTType.data]
    let bytes: Data
    init(_ bytes: Data) { self.bytes = bytes }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        self.bytes = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: bytes) }
}

struct MessageAttachmentView: View {
    let api: ConversationAPI
    let workspace: UUID
    let attachment: MessageAttachment
    @ViewState private var thumbnail: UIImage?
    @ViewState private var image: UIImage?
    @ViewState private var document: AttachmentDocument?
    @ViewState private var exporting = false
    @ViewState private var viewing = false
    @ViewState private var loading = false
    @ViewState private var failed = false
    @ViewState private var operation: Task<Void, Never>?

    private func raster(_ data: Data, pixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(source) as String?,
              [UTType.png.identifier, UTType.jpeg.identifier, UTType.gif.identifier, UTType.webP.identifier].contains(type),
              let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: scaled)
    }

    private var safeName: String {
        let name = attachment.name
        return name.isEmpty || name.hasPrefix(".") || name.contains("/") || name.contains("\\")
            || name.rangeOfCharacter(from: .controlCharacters) != nil ? "Attachment" : name
    }

    var body: some View {
        VStack(alignment: .leading) {
            Button {
                open()
            } label: {
                if attachment.isRasterImage {
                    // Reserve the preview before the first scroll to the latest message.
                    Color.clear.frame(maxWidth: 260).frame(height: 180)
                        .overlay(alignment: .leading) {
                            if let thumbnail {
                                Image(uiImage: thumbnail).resizable().scaledToFit()
                            } else {
                                Label(safeName, systemImage: "photo")
                            }
                        }
                        .contentShape(Rectangle())
                } else {
                    Label(safeName, systemImage: "doc")
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
            }
            .accessibilityLabel(safeName)
            .disabled(loading)
            if loading { ProgressView() }
            if failed { Text("Couldn’t open attachment."); Button("Retry", action: open) }
        }
        .task(id: attachment.id) {
            guard attachment.isRasterImage else { return }
            if let data = try? await api.download(attachment, workspace: workspace), !Task.isCancelled {
                thumbnail = raster(data, pixels: 520)
            }
        }
        .onDisappear { operation?.cancel() }
        .sheet(isPresented: $viewing, onDismiss: { image = nil }) {
            NavigationStack {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(safeName)
                        .toolbar { Button("Done") { viewing = false } }
                }
            }
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .data, defaultFilename: safeName) { result in
            document = nil
            if case .failure = result { failed = true }
        }
    }

    private func open() {
        guard !loading else { return }
        loading = true
        failed = false
        operation = Task { @MainActor in
            defer { loading = false }
            do {
                let data = try await api.download(attachment, workspace: workspace)
                try Task.checkCancellation()
                if attachment.isRasterImage, let decoded = raster(data, pixels: 2048) {
                    image = decoded
                    viewing = true
                } else {
                    document = AttachmentDocument(data)
                    exporting = true
                }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}
