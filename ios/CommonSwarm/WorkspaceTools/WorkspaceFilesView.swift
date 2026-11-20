import SwiftUI
import UIKit

struct WorkspaceFilesRoute: Hashable {}

struct WorkspaceFilesView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: WorkspaceFilesStore
    @Environment(\.colorScheme) private var colorScheme
    private let autoLoad: Bool

    init(
        api: ConversationAPI,
        workspace: Workspace,
        store: WorkspaceFilesStore? = nil,
        autoLoad: Bool = true
    ) {
        self.api = api
        self.workspace = workspace
        self.autoLoad = autoLoad
        _store = StateObject(wrappedValue: store ?? WorkspaceFilesStore(workspaceID: workspace.id))
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
        .background(
            ShareSheetPresenter(share: store.activeShareItem) { finishedShare in
                store.finishShare(finishedShare)
            }
        )
        .task {
            if autoLoad {
                await store.load(api: filesAPI)
            }
        }
        .onDisappear {
            store.retire()
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
        let state = store.downloadState(for: file)

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
            } else if isCompleted(state) {
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
                        store.startDownload(file, api: filesAPI)
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
                                Text(WorkspaceFilesRules.downloadButtonTitle(for: state))
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
                    .accessibilityLabel(
                        WorkspaceFilesRules.downloadButtonAccessibilityLabel(
                            state: state,
                            fileName: file.name,
                            version: file.currentVersion
                        )
                    )
                    .accessibilityIdentifier("workspace-file-download-\(file.fileID)")

                    if isCompleted(state) {
                        Button {
                            store.startShareOrSave(file, api: filesAPI)
                        } label: {
                            Text("Share / Save")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(isPreparing(state))
                        .accessibilityLabel("Share or save \(file.name), version \(file.currentVersion)")
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

    private func isCompleted(_ state: WorkspaceFileDownloadState) -> Bool {
        switch state {
        case .ready, .downloaded: true
        default: false
        }
    }
}

/// Presents `UIActivityViewController` directly so every dismissal path (completion, cancel, error,
/// interactive swipe-down, programmatic dismissal, or replacement) passes the exact immutable
/// `DownloadedFileShare` captured when that sheet was presented — never reading mutable current state.
private struct ShareSheetPresenter: UIViewControllerRepresentable {
    let share: DownloadedFileShare?
    let onFinish: @MainActor (DownloadedFileShare) -> Void

    @MainActor
    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        var onFinish: @MainActor (DownloadedFileShare) -> Void
        weak var hostController: UIViewController?
        private var desiredShare: DownloadedFileShare?
        private var presented: (item: DownloadedFileShare, controller: ManagedActivityViewController)?
        private var controllerItems: [ObjectIdentifier: DownloadedFileShare] = [:]
        private var finishedIDs: Set<UUID> = []
        private var isTransitioning = false

        init(onFinish: @escaping @MainActor (DownloadedFileShare) -> Void) {
            self.onFinish = onFinish
        }

        func sync(desired: DownloadedFileShare?, on host: UIViewController) {
            hostController = host
            desiredShare = desired
            guard !isTransitioning else { return }

            if let current = presented {
                if current.item.id == desired?.id {
                    return
                }
                let outgoing = current.item
                let outgoingVC = current.controller
                presented = nil
                if outgoingVC.presentingViewController != nil {
                    isTransitioning = true
                    outgoingVC.dismiss(animated: false) { [weak self, weak host] in
                        Task { @MainActor in
                            guard let self else { return }
                            self.finishOnce(outgoing, controllerID: ObjectIdentifier(outgoingVC), dismissController: false)
                            self.isTransitioning = false
                            if let host {
                                self.sync(desired: self.desiredShare, on: host)
                            }
                        }
                    }
                    return
                } else {
                    finishOnce(outgoing, controllerID: ObjectIdentifier(outgoingVC), dismissController: false)
                }
            }

            if let lingeringVC = host.presentedViewController as? ManagedActivityViewController,
               lingeringVC.presentedShare.id != desired?.id {
                let outgoing = lingeringVC.presentedShare
                isTransitioning = true
                lingeringVC.dismiss(animated: false) { [weak self, weak host] in
                    Task { @MainActor in
                        guard let self else { return }
                        self.finishOnce(outgoing, controllerID: ObjectIdentifier(lingeringVC), dismissController: false)
                        self.isTransitioning = false
                        if let host {
                            self.sync(desired: self.desiredShare, on: host)
                        }
                    }
                }
                return
            }

            guard let incoming = desired,
                  !finishedIDs.contains(incoming.id),
                  host.view.window != nil,
                  host.presentedViewController == nil else {
                return
            }

            let controller = ManagedActivityViewController(item: incoming) { [weak self] closedItem, controllerID in
                self?.finishOnce(closedItem, controllerID: controllerID, dismissController: true)
            }
            let controllerID = ObjectIdentifier(controller)
            controllerItems[controllerID] = incoming
            controller.presentationController?.delegate = self
            if let popover = controller.popoverPresentationController {
                popover.sourceView = host.view
                popover.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }

            presented = (incoming, controller)
            isTransitioning = true
            host.present(controller, animated: true) { [weak self, weak host] in
                Task { @MainActor in
                    guard let self else { return }
                    self.isTransitioning = false
                    if let host {
                        self.sync(desired: self.desiredShare, on: host)
                    }
                }
            }
        }

        func dismantle() {
            desiredShare = nil
            if let current = presented {
                let outgoing = current.item
                let outgoingVC = current.controller
                presented = nil
                if outgoingVC.presentingViewController != nil {
                    outgoingVC.dismiss(animated: false)
                }
                finishOnce(outgoing, controllerID: ObjectIdentifier(outgoingVC), dismissController: false)
            }
            for (controllerID, item) in controllerItems {
                finishOnce(item, controllerID: controllerID, dismissController: false)
            }
            controllerItems.removeAll()
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            let controllerID = ObjectIdentifier(presentationController.presentedViewController)
            guard let item = controllerItems[controllerID] else { return }
            finishOnce(item, controllerID: controllerID, dismissController: false)
        }

        private func finishOnce(
            _ item: DownloadedFileShare,
            controllerID: ObjectIdentifier,
            dismissController: Bool
        ) {
            controllerItems.removeValue(forKey: controllerID)
            let controllerToDismiss: ManagedActivityViewController?
            if presented?.item.id == item.id {
                controllerToDismiss = presented?.controller
                presented = nil
            } else {
                controllerToDismiss = nil
            }
            let newlyFinished = finishedIDs.insert(item.id).inserted
            if newlyFinished {
                onFinish(item)
            }
            guard !isTransitioning else { return }
            if dismissController,
               let controllerToDismiss,
               controllerToDismiss.presentingViewController != nil,
               !controllerToDismiss.isBeingDismissed {
                isTransitioning = true
                controllerToDismiss.dismiss(animated: false) { [weak self] in
                    Task { @MainActor in
                        guard let self else { return }
                        self.isTransitioning = false
                        if let host = self.hostController {
                            self.sync(desired: self.desiredShare, on: host)
                        }
                    }
                }
            } else if let host = hostController, desiredShare?.id != nil {
                sync(desired: desiredShare, on: host)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> HostController {
        let host = HostController()
        host.onDidMoveToWindow = { [weak coordinator = context.coordinator, weak host] in
            guard let coordinator, let host else { return }
            coordinator.sync(desired: share, on: host)
        }
        return host
    }

    func updateUIViewController(_ uiViewController: HostController, context: Context) {
        context.coordinator.onFinish = onFinish
        uiViewController.onDidMoveToWindow = { [weak coordinator = context.coordinator, weak uiViewController] in
            guard let coordinator, let uiViewController else { return }
            coordinator.sync(desired: share, on: uiViewController)
        }
        context.coordinator.sync(desired: share, on: uiViewController)
    }

    static func dismantleUIViewController(_ uiViewController: HostController, coordinator: Coordinator) {
        uiViewController.onDidMoveToWindow = nil
        coordinator.dismantle()
    }

    final class HostController: UIViewController {
        var onDidMoveToWindow: (() -> Void)?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            onDidMoveToWindow?()
        }
    }
}

private final class ManagedActivityViewController: UIActivityViewController {
    let presentedShare: DownloadedFileShare
    private let onFinished: @MainActor (DownloadedFileShare, ObjectIdentifier) -> Void

    init(
        item: DownloadedFileShare,
        onFinished: @escaping @MainActor (DownloadedFileShare, ObjectIdentifier) -> Void
    ) {
        self.presentedShare = item
        self.onFinished = onFinished
        super.init(activityItems: [item.fileURL], applicationActivities: nil)
        let capturedItem = item
        let controllerID = ObjectIdentifier(self)
        self.completionWithItemsHandler = { [weak self] _, _, _, _ in
            Task { @MainActor in
                self?.onFinished(capturedItem, controllerID)
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || (presentingViewController == nil && parent == nil) {
            onFinished(presentedShare, ObjectIdentifier(self))
        }
    }
}
