import SwiftUI
import UIKit

struct WorkspaceFilesRoute: Hashable {}

struct WorkspaceFilesView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: WorkspaceFilesStore
    @Environment(\.colorScheme) private var colorScheme

    init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
        _store = StateObject(wrappedValue: WorkspaceFilesStore(workspaceID: workspace.id))
    }

    private var filesAPI: WorkspaceFilesAPI { WorkspaceFilesAPI(api: api) }

    private var primaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var secondaryForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var secondaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var sharedBadgeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.49, green: 0.75, blue: 1.00)
            : Color(red: 0.00, green: 0.32, blue: 0.70)
    }

    private var sharedBadgeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.20, blue: 0.32)
            : Color(red: 0.89, green: 0.94, blue: 1.00)
    }

    private var removedBadgeForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.78, blue: 0.44)
            : Color(red: 0.52, green: 0.26, blue: 0.00)
    }

    private var removedBadgeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.28, green: 0.18, blue: 0.06)
            : Color(red: 0.99, green: 0.93, blue: 0.84)
    }

    private var readyBadgeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.68, green: 0.96, blue: 0.75)
            : Color(red: 0.06, green: 0.34, blue: 0.14)
    }

    private var readyBadgeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.09, green: 0.24, blue: 0.14)
            : Color(red: 0.86, green: 0.96, blue: 0.89)
    }

    var body: some View {
        Group {
            if store.accessUnavailable {
                ContentUnavailableView(
                    "Access unavailable",
                    systemImage: "lock.slash",
                    description: Text("You don’t have access to files in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.isLoading && store.files.isEmpty {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.loadFailed && store.files.isEmpty {
                RetryView(text: "Couldn’t load files") {
                    await store.load(api: filesAPI)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.files.isEmpty {
                ContentUnavailableView(
                    "No files shared yet",
                    systemImage: "doc"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        untrustedWarningCard

                        ForEach(store.files) { file in
                            fileCard(file)
                        }
                    }
                    .padding()
                }
                .refreshable {
                    await store.load(api: filesAPI)
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $store.activeShareItem) { item in
            FileActivityShareSheet(fileURL: item.fileURL)
        }
        .task {
            await store.load(api: filesAPI)
        }
    }

    private var untrustedWarningCard: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(mutedForeground)
                .padding(.top, 2)
                .accessibilityHidden(true)
            Text("Treat downloaded files as untrusted input and do not execute unverified archives or scripts.")
                .font(.footnote)
                .foregroundStyle(mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func fileCard(_ file: WorkspaceFileItem) -> some View {
        let state = store.downloadStates[file.fileID] ?? .idle

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: file.isRemoved ? "doc.badge.clock" : "doc.fill")
                    .font(.title3)
                    .foregroundStyle(file.isRemoved ? mutedForeground : sharedBadgeForeground)
                    .padding(.top, 2)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 6) {
                    Text(file.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 6) {
                        if file.isRemoved {
                            let label = file.restoreDeadlineLabel.map { "Removed · restorable until \($0)" } ?? "Removed"
                            Text(label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(removedBadgeForeground)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(removedBadgeBackground, in: Capsule())
                        } else {
                            Text("Shared")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(sharedBadgeForeground)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(sharedBadgeBackground, in: Capsule())
                        }

                        Text("v\(file.currentVersion)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(secondaryForeground)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(secondaryBackground, in: Capsule())
                    }
                }
            }

            HStack(spacing: 6) {
                Image(systemName: file.isAgentUploader ? "cpu" : "person.crop.circle")
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .accessibilityHidden(true)
                Text("\(file.formattedSize) · \(file.uploaderLabel) · \(file.relativeAgeLabel)")
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if case .failed(let message) = state {
                Text(message)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(errorForeground)
                    .fixedSize(horizontal: false, vertical: true)
            } else if case .ready = state {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(readyBadgeForeground)
                        .accessibilityHidden(true)
                    Text("Downloaded · ready to open or save")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(readyBadgeForeground)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(readyBadgeBackground, in: Capsule())
            }

            if !file.isRemoved {
                HStack(spacing: 10) {
                    Button {
                        Task { await store.download(file, api: filesAPI) }
                    } label: {
                        HStack(spacing: 8) {
                            if case .preparing = state {
                                ProgressView()
                                    .tint(.white)
                                Text("Preparing…")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                            } else {
                                Image(systemName: "arrow.down.circle")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .accessibilityHidden(true)
                                Text(downloadButtonTitle(state))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isPreparing(state))
                    .accessibilityLabel("Download \(file.name), version \(file.currentVersion)")
                    .accessibilityIdentifier("workspace-file-download-\(file.fileID)")

                    if case .ready = state {
                        Button {
                            store.openReadyDownload(for: file.fileID)
                        } label: {
                            Text("Share / Save")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("workspace-file-share-\(file.fileID)")
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace-file-card-\(file.fileID)")
    }

    private func isPreparing(_ state: WorkspaceFileDownloadState) -> Bool {
        if case .preparing = state { return true }
        return false
    }

    private func downloadButtonTitle(_ state: WorkspaceFileDownloadState) -> String {
        switch state {
        case .failed: "Retry download"
        case .ready: "Download again"
        case .idle, .preparing: "Download"
        }
    }
}

private struct FileActivityShareSheet: UIViewControllerRepresentable {
    let fileURL: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
