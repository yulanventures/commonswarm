import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

private typealias ViewState<Value> = SwiftUI.State<Value>

private struct PickedMedia: Transferable {
    let file: StagedFile
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try Self(file: StagedFile(source: received.file)) }
        FileRepresentation(importedContentType: .image) { received in try Self(file: StagedFile(source: received.file)) }
    }
}

struct AttachmentPicker: View {
    @ObservedObject var draft: Composer
    @ViewState private var photos = false
    @ViewState private var files = false
    @ViewState private var camera = false
    @ViewState private var selection: [PhotosPickerItem] = []
    @ViewState private var error: String?
    @ViewState private var importing = false

    var body: some View {
        Menu {
            Button("Photos and videos", systemImage: "photo.on.rectangle") { photos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Camera", systemImage: "camera") { camera = true }
            }
            Button("Files", systemImage: "folder") { files = true }
        } label: {
            Image(systemName: "plus.circle").font(.title2).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Attach files")
        .disabled(importing || draft.attachments.count >= 8)
        .photosPicker(isPresented: $photos, selection: $selection,
                      maxSelectionCount: max(1, 8 - draft.attachments.count), matching: .any(of: [.images, .videos]),
                      preferredItemEncoding: .compatible)
        .task(id: selection) {
            guard !selection.isEmpty else { return }
            importing = true
            defer { importing = false }
            do {
                for item in selection {
                    guard let picked = try await item.loadTransferable(type: PickedMedia.self) else { throw AttachmentError.type }
                    try Task.checkCancellation()
                    try draft.stage(picked.file)
                }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            selection = []
        }
        .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            do {
                let urls = try result.get()
                guard urls.count + draft.attachments.count <= 8 else { throw AttachmentError.count }
                for url in urls {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    try draft.stage(StagedFile(source: url))
                }
            } catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $camera) {
            AttachmentCamera { result in
                camera = false
                guard let result else { return }
                do { try draft.stage(result.get()) } catch { self.error = error.localizedDescription }
            }.ignoresSafeArea()
        }
        .alert("Couldn’t attach file", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }
}

private struct AttachmentCamera: UIViewControllerRepresentable {
    let finish: (Result<StagedFile, Error>?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(finish: finish) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeMedium
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let finish: (Result<StagedFile, Error>?) -> Void
        init(finish: @escaping (Result<StagedFile, Error>?) -> Void) { self.finish = finish }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { finish(nil) }
        func imagePickerController(_ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            finish(Result {
                let stem = "Camera-" + UUID().uuidString
                if let movie = info[.mediaURL] as? URL { return try StagedFile(source: movie, name: stem + "." + movie.pathExtension) }
                guard let photo = info[.originalImage] as? UIImage, let data = photo.jpegData(compressionQuality: 0.9) else { throw AttachmentError.type }
                return try StagedFile(data: data, name: stem + ".jpg")
            })
        }
    }
}

struct FileUploadProgress: View {
    @ObservedObject var intent: UploadIntent
    var body: some View {
        VStack(alignment: .leading) {
            Text(intent.file.name).font(.caption)
            ProgressView(value: intent.fraction).accessibilityLabel("Upload progress")
        }
    }
}
