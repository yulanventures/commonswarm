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
    case move(itemID: String, beforeOrder: Int, afterItemID: String?)

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
        case .move(let itemID, let beforeOrder, let afterItemID):
            try container.encode("move", forKey: .kind)
            try container.encode(itemID, forKey: .item_id)
            try container.encode(beforeOrder, forKey: .before_order)
            try container.encode(afterItemID, forKey: .after_item_id)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, item_id, text, checked, after_item_id, before_text, before_checked, before_order
    }
}

struct SharedDocSplice: Encodable, Equatable, Sendable {
    let start: Int
    let before: String
    let after: String
}

enum SharedPatch: Encodable, Equatable, Sendable {
    case list([SharedListPatchOp])
    case doc([SharedDocSplice])

    var isEmpty: Bool {
        switch self {
        case .list(let ops): ops.isEmpty
        case .doc(let splices): splices.isEmpty
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .list(let operations):
            try container.encode("list", forKey: .kind)
            try container.encode(operations, forKey: .operations)
        case .doc(let splices):
            try container.encode("doc", forKey: .kind)
            try container.encode(splices, forKey: .splices)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, operations, splices
    }
}

struct SharedRevisionEntry: Hashable, Identifiable, Sendable {
    let revision: SharedRevisionRef
    let title: String
    let authorLabel: String
    let authorIsAgent: Bool
    let occurredAtServerMs: Int64
    let live: Bool

    var id: String { revision.token }

    var formattedSavedAt: String {
        guard occurredAtServerMs > 0 else { return "" }
        let date = Date(timeIntervalSince1970: Double(occurredAtServerMs) / 1000.0)
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

struct SharedConflictDraft: Equatable, Sendable {
    let workspaceID: UUID
    let objectID: String
    let draftID: String
    let ownerUserID: UUID
    let base: SharedObjectDetail
    let current: SharedObjectDetail
    let proposed: SharedContent
}

enum SharedObjectsError: Error, Equatable, Sendable {
    case refused(reason: String)
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

    /// Mirrors householdContentPatch in site/src/lib/household-objects-view.ts.
    static func buildPatch(from base: SharedContent, to proposed: SharedContent) -> SharedPatch? {
        switch (base, proposed) {
        case (.doc(let baseMarkdown), .doc(let proposedMarkdown)):
            return .doc([SharedDocSplice(start: 0, before: baseMarkdown, after: proposedMarkdown)])
        case (.list(let baseItems), .list(let proposedItems)):
            guard Set(proposedItems.map(\.item_id)).count == proposedItems.count else { return nil }
            var operations: [SharedListPatchOp] = []
            var working = baseItems.sorted { $0.order < $1.order }
            let proposedIDs = Set(proposedItems.map(\.item_id))
            for item in working where !proposedIDs.contains(item.item_id) {
                operations.append(.remove(itemID: item.item_id, beforeText: item.text, beforeChecked: item.checked))
                working.removeAll { $0.item_id == item.item_id }
            }
            let wanted = proposedItems.sorted { $0.order < $1.order }
            for (index, item) in wanted.enumerated() {
                let afterID = index > 0 ? wanted[index - 1].item_id : nil
                if let found = working.firstIndex(where: { $0.item_id == item.item_id }) {
                    let old = working[found]
                    if old.text != item.text || old.checked != item.checked {
                        operations.append(.set(
                            itemID: item.item_id,
                            beforeText: old.text,
                            beforeChecked: old.checked,
                            text: item.text,
                            checked: item.checked
                        ))
                    }
                    if found != index {
                        operations.append(.move(itemID: item.item_id, beforeOrder: found, afterItemID: afterID))
                        working.remove(at: found)
                        working.insert(item, at: min(index, working.count))
                    }
                } else {
                    operations.append(.add(itemID: item.item_id, text: item.text, checked: item.checked, afterItemID: afterID))
                    working.insert(item, at: min(index, working.count))
                }
            }
            return .list(operations)
        default:
            return nil
        }
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
            return "This item changed since it loaded. Reload it to review."
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
        if let linkRegex = try? NSRegularExpression(pattern: #"\[([^\]]+)\]\(([^)]+)\)"#) {
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            out = linkRegex.stringByReplacingMatches(in: out, range: range, withTemplate: "$1")
        }
        out = out.replacingOccurrences(of: "**", with: "")
        out = out.replacingOccurrences(of: "__", with: "")
        return out
    }
}

struct SharedPendingEdit: Equatable, Sendable {
    let commandID: UUID
    let base: SharedRevisionRef
    let patch: SharedPatch
    let pendingNewItemText: String?
}

struct SharedPendingCreate: Equatable, Sendable {
    let commandID: UUID
    let objectID: String
    let title: String
    let content: SharedContent
}

@MainActor
final class SharedObjectsListStore: ObservableObject {
    @Published var filter: SharedObjectsFilter = .all
    @Published private(set) var accessStatus: SharedAccessStatus?
    @Published private(set) var objects: [SharedObjectSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isCreating = false
    @Published private(set) var createError: String?
    @Published private(set) var pendingCreate: SharedPendingCreate?

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
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                objects = []
                if reason == "content_consent_required" {
                    accessStatus = .needsConfirmation(reason: reason)
                } else {
                    accessStatus = .refused(reason: reason)
                }
            }
        } catch {
            if !Task.isCancelled {
                loadFailed = true
            }
        }
        isLoading = false
    }

    func createObject(
        title rawTitle: String,
        kind: SharedObjectKind,
        initialMarkdown: String = "",
        api: SharedObjectsAPI
    ) async -> SharedObjectSummary? {
        guard access?.canCreate == true, !isCreating else { return nil }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            createError = "Enter a title."
            return nil
        }
        let content: SharedContent = kind == .doc ? .doc(initialMarkdown) : .list([])
        let req: SharedPendingCreate
        if let existing = pendingCreate, existing.title == title, existing.content == content {
            req = existing
        } else {
            req = SharedPendingCreate(
                commandID: UUID(),
                objectID: "obj_" + UUID().uuidString.lowercased(),
                title: title,
                content: content
            )
        }
        pendingCreate = req
        isCreating = true
        createError = nil

        let outcome = await api.createObject(
            workspaceID: workspaceID,
            objectID: req.objectID,
            title: req.title,
            content: req.content,
            requestID: req.commandID
        )
        isCreating = false

        switch outcome {
        case .committed(let rev):
            pendingCreate = nil
            createError = nil
            let created = SharedObjectSummary(objectID: req.objectID, kind: kind, title: req.title, revision: rev)
            if let fresh = try? await api.listObjects(workspaceID: workspaceID) {
                objects = fresh
            } else if !objects.contains(where: { $0.objectID == created.objectID }) {
                objects.insert(created, at: 0)
            }
            return created
        case .refused(let reason, let message):
            switch reason {
            case "workspace_access_refused", "connection_access_refused":
                objects = []
                pendingCreate = nil
                accessStatus = .refused(reason: reason)
            case "content_consent_required":
                objects = []
                pendingCreate = nil
                accessStatus = .needsConfirmation(reason: reason)
            case "content_read_only":
                pendingCreate = nil
                accessStatus = .granted(SharedAccess(role: .reader, operations: ["read"]))
            default:
                break
            }
            createError = message
            return nil
        case .conflict:
            pendingCreate = nil
            createError = "That item already exists. Reload to see it."
            return nil
        case .unconfirmed(let message):
            createError = message
            return nil
        }
    }

    func resetCreateState() {
        createError = nil
        pendingCreate = nil
    }
}

@MainActor
final class SharedObjectDetailStore: ObservableObject {
    @Published private(set) var access: SharedAccess?
    @Published private(set) var accessStatus: SharedAccessStatus?
    @Published private(set) var detail: SharedObjectDetail?
    @Published private(set) var openedRevision: SharedObjectDetail?
    @Published private(set) var history: [SharedRevisionEntry] = []
    @Published private(set) var nextHistoryOffset: Int?
    @Published private(set) var isLoadingHistory = false
    @Published var showRevisionIDs = false

    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isSaving = false
    @Published private(set) var saveBanner: String?
    @Published private(set) var postSaveRefreshMessage: String?
    @Published private(set) var conflictMessage: String?
    @Published private(set) var conflictDraftID: String?
    @Published private(set) var recoveredConflict: SharedConflictDraft?
    @Published private(set) var isRecoveringDraft = false
    @Published var showOriginalInConflict = false
    @Published var reviewedConflictConfirmed = false

    @Published private(set) var saveError: String?
    @Published private(set) var pendingEdit: SharedPendingEdit?
    @Published var newItemText = ""
    @Published var isEditingDoc = false
    @Published var docDraftText = ""
    @Published private(set) var docEditBaseRevision: SharedRevisionRef?
    @Published private(set) var docEditBaseMarkdown: String?

    let workspaceID: UUID
    let objectID: String
    let expectedKind: SharedObjectKind
    private var bannerTask: Task<Void, Never>?

    init(workspaceID: UUID, objectID: String, expectedKind: SharedObjectKind, access: SharedAccess?) {
        self.workspaceID = workspaceID
        self.objectID = objectID
        self.expectedKind = expectedKind
        self.access = access
        self.accessStatus = access.map { .granted($0) }
    }

    var displayedDetail: SharedObjectDetail? {
        openedRevision ?? detail
    }

    var isViewingEarlierRevision: Bool {
        openedRevision != nil
    }

    var needsRefreshAfterSave: Bool {
        postSaveRefreshMessage != nil
    }

    var newerRevisionAvailableWhileEditing: Bool {
        guard isEditingDoc, let base = docEditBaseRevision, let current = detail?.revision else { return false }
        return base != current
    }

    var canEditList: Bool {
        expectedKind == .list
            && (access?.canUpdate ?? false)
            && !isSaving
            && conflictMessage == nil
            && pendingEdit == nil
            && !needsRefreshAfterSave
            && !isViewingEarlierRevision
            && recoveredConflict == nil
    }

    var canEditDoc: Bool {
        expectedKind == .doc
            && (access?.canUpdate ?? false)
            && !isSaving
            && conflictMessage == nil
            && pendingEdit == nil
            && !needsRefreshAfterSave
            && !isViewingEarlierRevision
            && recoveredConflict == nil
    }

    private var postSaveRefreshCopy: String {
        expectedKind == .doc
            ? "Saved. Couldn’t refresh the doc."
            : "Saved. Couldn’t refresh the list."
    }

    private func applyAccessEnded(_ status: SharedAccessStatus) {
        bannerTask?.cancel()
        detail = nil
        openedRevision = nil
        history = []
        nextHistoryOffset = nil
        access = nil
        accessStatus = status
        pendingEdit = nil
        conflictMessage = nil
        conflictDraftID = nil
        recoveredConflict = nil
        showOriginalInConflict = false
        reviewedConflictConfirmed = false
        isEditingDoc = false
        docEditBaseRevision = nil
        docEditBaseMarkdown = nil
        saveError = nil
        postSaveRefreshMessage = nil
        saveBanner = nil
        loadFailed = false
    }

    func load(api: SharedObjectsAPI) async {
        isLoading = true
        if postSaveRefreshMessage == nil {
            loadFailed = false
        }
        do {
            let status = try await api.access(workspaceID: workspaceID)
            guard !Task.isCancelled else {
                isLoading = false
                return
            }
            switch status {
            case .refused(let reason):
                applyAccessEnded(.refused(reason: reason))
                isLoading = false
                return
            case .needsConfirmation(let reason):
                applyAccessEnded(.needsConfirmation(reason: reason))
                isLoading = false
                return
            case .granted(let freshAccess):
                guard freshAccess.canRead else {
                    applyAccessEnded(.refused(reason: "workspace_access_refused"))
                    isLoading = false
                    return
                }
                access = freshAccess
                accessStatus = .granted(freshAccess)
                if !freshAccess.canUpdate {
                    pendingEdit = nil
                    isEditingDoc = false
                    docEditBaseRevision = nil
                    docEditBaseMarkdown = nil
                    recoveredConflict = nil
                    conflictDraftID = nil
                }
            }

            let loaded = try await api.readObject(workspaceID: workspaceID, objectID: objectID, expectedKind: expectedKind)
            guard !Task.isCancelled else {
                isLoading = false
                return
            }
            detail = loaded
            openedRevision = nil
            conflictMessage = nil
            conflictDraftID = nil
            recoveredConflict = nil
            showOriginalInConflict = false
            reviewedConflictConfirmed = false
            saveError = nil
            pendingEdit = nil
            postSaveRefreshMessage = nil
            loadFailed = false
            if case .doc(let md) = loaded.content, !isEditingDoc {
                docDraftText = md
            }
            await refreshHistory(api: api)
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                handleReadRefusal(reason)
            }
        } catch {
            if !Task.isCancelled, postSaveRefreshMessage == nil {
                loadFailed = true
            }
        }
        isLoading = false
    }

    func retryPostSaveRefresh(api: SharedObjectsAPI) async {
        guard needsRefreshAfterSave, !isLoading, !isSaving else { return }
        await load(api: api)
    }

    private func refreshHistory(api: SharedObjectsAPI) async {
        do {
            let page = try await api.readHistory(workspaceID: workspaceID, objectID: objectID, offset: 0)
            guard !Task.isCancelled else { return }
            history = page.revisions
            nextHistoryOffset = page.nextOffset
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                handleReadRefusal(reason)
            }
        } catch {
            // Keep existing history if history fetch transiently fails
        }
    }

    func loadMoreHistory(api: SharedObjectsAPI) async {
        guard let offset = nextHistoryOffset, !isLoadingHistory else { return }
        isLoadingHistory = true
        do {
            let page = try await api.readHistory(workspaceID: workspaceID, objectID: objectID, offset: offset)
            guard !Task.isCancelled else {
                isLoadingHistory = false
                return
            }
            let existing = Set(history.map(\.id))
            for entry in page.revisions where !existing.contains(entry.id) {
                history.append(entry)
            }
            nextHistoryOffset = page.nextOffset
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                handleReadRefusal(reason)
            }
        } catch {
            // Non-fatal; user can retry Load more history
        }
        isLoadingHistory = false
    }

    func openRevision(_ entry: SharedRevisionEntry, api: SharedObjectsAPI) async {
        if entry.revision == detail?.revision {
            openedRevision = nil
            return
        }
        isLoading = true
        do {
            let historical = try await api.readObject(
                workspaceID: workspaceID,
                objectID: objectID,
                expectedKind: expectedKind,
                revision: entry.revision
            )
            guard !Task.isCancelled else {
                isLoading = false
                return
            }
            openedRevision = historical
            isEditingDoc = false
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                handleReadRefusal(reason)
            }
        } catch {
            // Keep current view if historical revision transiently failed to load
        }
        isLoading = false
    }

    func backToCurrent() {
        openedRevision = nil
    }

    func beginEditingDoc() {
        guard canEditDoc, let current = detail, case .doc(let md) = current.content else { return }
        docEditBaseRevision = current.revision
        docEditBaseMarkdown = md
        docDraftText = md
        isEditingDoc = true
        saveError = nil
    }

    func cancelEditingDoc() {
        isEditingDoc = false
        docEditBaseRevision = nil
        docEditBaseMarkdown = nil
        if case .doc(let md) = detail?.content {
            docDraftText = md
        }
        saveError = nil
        pendingEdit = nil
    }

    func saveDoc(api: SharedObjectsAPI) async {
        guard canEditDoc, let current = detail, case .doc(let currentMarkdown) = current.content else { return }
        let baseRevision = docEditBaseRevision ?? current.revision
        let baseMarkdown = docEditBaseMarkdown ?? currentMarkdown
        let patch = SharedPatch.doc([SharedDocSplice(start: 0, before: baseMarkdown, after: docDraftText)])
        await applyPatch(
            SharedPendingEdit(commandID: UUID(), base: baseRevision, patch: patch, pendingNewItemText: nil),
            api: api
        )
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
        await applyPatch(
            SharedPendingEdit(commandID: UUID(), base: current.revision, patch: .list([op]), pendingNewItemText: nil),
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
        await applyPatch(
            SharedPendingEdit(commandID: UUID(), base: current.revision, patch: .list([op]), pendingNewItemText: nil),
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
        await applyPatch(
            SharedPendingEdit(commandID: UUID(), base: current.revision, patch: .list([op]), pendingNewItemText: trimmed),
            api: api
        )
    }

    func retryPendingEdit(api: SharedObjectsAPI) async {
        guard let pendingEdit, !isSaving else { return }
        await applyPatch(pendingEdit, api: api)
    }

    func recoverDraft(api: SharedObjectsAPI) async {
        guard let draftID = conflictDraftID, !isRecoveringDraft else { return }
        isRecoveringDraft = true
        saveError = nil
        do {
            let recovered = try await api.recoverDraft(
                workspaceID: workspaceID,
                objectID: objectID,
                draftID: draftID,
                expectedKind: expectedKind
            )
            guard !Task.isCancelled else {
                isRecoveringDraft = false
                return
            }
            recoveredConflict = recovered
            showOriginalInConflict = false
            reviewedConflictConfirmed = false
        } catch SharedObjectsError.refused(let reason) {
            if !Task.isCancelled {
                if reason == "workspace_access_refused" || reason == "connection_access_refused" || reason == "content_consent_required" {
                    handleReadRefusal(reason)
                } else {
                    saveError = "Couldn’t recover your draft. Reload to see the current version."
                }
            }
        } catch {
            if !Task.isCancelled {
                saveError = "Couldn’t recover your draft. Reload to see the current version."
            }
        }
        isRecoveringDraft = false
    }

    func saveReviewedConflict(api: SharedObjectsAPI) async {
        guard access?.canUpdate == true,
              !isSaving,
              !needsRefreshAfterSave,
              reviewedConflictConfirmed,
              let conflict = recoveredConflict else {
            return
        }
        if let pendingEdit {
            await applyPatch(pendingEdit, api: api)
            return
        }
        guard let patch = SharedObjectsRules.buildPatch(from: conflict.current.content, to: conflict.proposed) else {
            return
        }
        await applyPatch(
            SharedPendingEdit(commandID: UUID(), base: conflict.current.revision, patch: patch, pendingNewItemText: nil),
            api: api
        )
    }

    private func handleReadRefusal(_ reason: String) {
        switch reason {
        case "content_consent_required":
            applyAccessEnded(.needsConfirmation(reason: reason))
        case "workspace_access_refused", "connection_access_refused":
            applyAccessEnded(.refused(reason: reason))
        case "object_not_found":
            bannerTask?.cancel()
            detail = nil
            openedRevision = nil
            pendingEdit = nil
            postSaveRefreshMessage = nil
            saveBanner = nil
            loadFailed = true
        default:
            if postSaveRefreshMessage == nil {
                loadFailed = true
            }
        }
    }

    private func applyPatch(_ edit: SharedPendingEdit, api: SharedObjectsAPI) async {
        isSaving = true
        defer { isSaving = false }
        saveError = nil
        conflictMessage = nil
        pendingEdit = edit

        let outcome = await api.updateObject(
            workspaceID: workspaceID,
            objectID: objectID,
            base: edit.base,
            patch: edit.patch,
            requestID: edit.commandID
        )

        switch outcome {
        case .committed:
            pendingEdit = nil
            conflictDraftID = nil
            recoveredConflict = nil
            reviewedConflictConfirmed = false
            isEditingDoc = false
            docEditBaseRevision = nil
            docEditBaseMarkdown = nil
            if edit.pendingNewItemText != nil {
                newItemText = ""
            }
            await refreshAfterCommittedSave(api: api)
        case .conflict(_, let draftID):
            pendingEdit = nil
            isEditingDoc = false
            docEditBaseRevision = nil
            docEditBaseMarkdown = nil
            conflictDraftID = draftID
            recoveredConflict = nil
            reviewedConflictConfirmed = false
            conflictMessage = "Someone saved another revision. Recover your draft to compare changes before saving."
        case .refused(let reason, let message):
            switch reason {
            case "workspace_access_refused", "connection_access_refused":
                applyAccessEnded(.refused(reason: reason))
            case "content_consent_required":
                applyAccessEnded(.needsConfirmation(reason: reason))
            case "content_read_only":
                let reader = SharedAccess(role: .reader, operations: ["read"])
                access = reader
                accessStatus = .granted(reader)
                pendingEdit = nil
                isEditingDoc = false
                docEditBaseRevision = nil
                docEditBaseMarkdown = nil
                recoveredConflict = nil
                conflictDraftID = nil
                saveError = message
            default:
                saveError = message
            }
        case .unconfirmed(let message):
            saveError = message
        }
    }

    private func refreshAfterCommittedSave(api: SharedObjectsAPI) async {
        do {
            let status = try await api.access(workspaceID: workspaceID)
            switch status {
            case .refused(let reason):
                applyAccessEnded(.refused(reason: reason))
                return
            case .needsConfirmation(let reason):
                applyAccessEnded(.needsConfirmation(reason: reason))
                return
            case .granted(let freshAccess):
                guard freshAccess.canRead else {
                    applyAccessEnded(.refused(reason: "workspace_access_refused"))
                    return
                }
                access = freshAccess
                accessStatus = .granted(freshAccess)
            }
            let fresh = try await api.readObject(workspaceID: workspaceID, objectID: objectID, expectedKind: expectedKind)
            detail = fresh
            openedRevision = nil
            postSaveRefreshMessage = nil
            loadFailed = false
            if case .doc(let md) = fresh.content {
                docDraftText = md
            }
            await refreshHistory(api: api)
            showSavedBanner("Saved")
        } catch SharedObjectsError.refused(let reason) {
            if reason == "content_consent_required" || reason == "workspace_access_refused" || reason == "connection_access_refused" {
                handleReadRefusal(reason)
            } else {
                bannerTask?.cancel()
                saveBanner = nil
                postSaveRefreshMessage = postSaveRefreshCopy
            }
        } catch {
            bannerTask?.cancel()
            saveBanner = nil
            postSaveRefreshMessage = postSaveRefreshCopy
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
