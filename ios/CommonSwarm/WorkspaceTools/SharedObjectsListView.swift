import SwiftUI

struct SharedObjectsRoute: Hashable {}

struct SharedObjectsListView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: SharedObjectsListStore
    @Environment(\.colorScheme) private var colorScheme

    init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
        _store = StateObject(wrappedValue: SharedObjectsListStore(workspaceID: workspace.id))
    }

    private var objectsAPI: SharedObjectsAPI { SharedObjectsAPI(api: api) }

    private var selectedPillBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var unselectedPillForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var unselectedPillBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    var body: some View {
        Group {
            if store.isLoading && store.accessStatus == nil {
                ProgressView("Loading lists and docs…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.loadFailed && store.objects.isEmpty {
                RetryView(text: "Couldn’t load lists and docs") {
                    await store.load(api: objectsAPI)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .needsConfirmation = store.accessStatus {
                VStack(spacing: 14) {
                    ContentUnavailableView(
                        "Confirm content access",
                        systemImage: "lock.doc",
                        description: Text("Choose reader or editor access for this workspace before opening shared lists and docs.")
                    )
                    Button {
                        Task { await store.load(api: objectsAPI) }
                    } label: {
                        Text("Retry")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(unselectedPillForeground)
                            .padding(.horizontal, 20)
                            .frame(minWidth: 88, minHeight: 44)
                            .background(unselectedPillBackground, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .refused = store.accessStatus {
                ContentUnavailableView(
                    "Access unavailable",
                    systemImage: "lock.slash",
                    description: Text("You don’t have read access to shared lists and docs in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                listContent
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Lists & docs")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: SharedObjectSummary.self) { summary in
            SharedObjectDetailView(
                api: api,
                workspace: workspace,
                summary: summary,
                access: store.access
            )
        }
        .task {
            await store.load(api: objectsAPI)
        }
    }

    private var listContent: some View {
        let visible = store.visibleObjects
        return VStack(spacing: 0) {
            filterHeader
                .padding(.top, 8)
                .padding(.bottom, 10)

            if visible.isEmpty {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: store.filter == .docs ? "doc.text" : "checklist"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(visible) { item in
                        NavigationLink(value: item) {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: item.kind.symbolName)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 24, height: 24)
                                    .padding(.top, 2)
                                    .accessibilityHidden(true)

                                VStack(alignment: .leading, spacing: 6) {
                                    Text(item.title)
                                        .font(.headline)
                                        .foregroundStyle(.primary)
                                        .fixedSize(horizontal: false, vertical: true)

                                    SharedObjectKindBadge(kind: item.kind)
                                }
                            }
                            .padding(.vertical, 6)
                        }
                        .accessibilityIdentifier("shared-object-row-\(item.objectID)")
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable {
                    await store.load(api: objectsAPI)
                }
            }
        }
    }

    private var filterHeader: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SharedObjectsFilter.allCases) { option in
                        let selected = store.filter == option
                        Button {
                            store.filter = option
                        } label: {
                            Text(option.title)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(selected ? Color.white : unselectedPillForeground)
                                .padding(.horizontal, 14)
                                .frame(minWidth: 64, minHeight: 44)
                                .background(
                                    selected ? selectedPillBackground : unselectedPillBackground,
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("shared-objects-filter-\(option.rawValue)")
                    }
                }
                .padding(.horizontal)
            }

            if let role = store.access?.role {
                Text(role.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(unselectedPillForeground)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(unselectedPillBackground, in: Capsule())
                    .padding(.trailing)
                    .accessibilityLabel("Content role: \(role.label)")
            }
        }
    }

    private var emptyTitle: String {
        switch store.filter {
        case .all: "No lists or docs yet"
        case .lists: "No lists yet"
        case .docs: "No docs yet"
        }
    }
}

struct SharedObjectKindBadge: View {
    let kind: SharedObjectKind
    @Environment(\.colorScheme) private var colorScheme

    private var foreground: Color {
        switch kind {
        case .list:
            return colorScheme == .dark ? Color(red: 0.49, green: 0.75, blue: 1.00) : Color(red: 0.00, green: 0.32, blue: 0.70)
        case .doc:
            return colorScheme == .dark ? Color(red: 0.44, green: 0.87, blue: 0.56) : Color(red: 0.07, green: 0.42, blue: 0.17)
        default:
            return colorScheme == .dark ? Color(red: 0.90, green: 0.91, blue: 0.94) : Color(red: 0.15, green: 0.17, blue: 0.21)
        }
    }

    private var background: Color {
        switch kind {
        case .list:
            return colorScheme == .dark ? Color(red: 0.08, green: 0.20, blue: 0.32) : Color(red: 0.89, green: 0.94, blue: 1.00)
        case .doc:
            return colorScheme == .dark ? Color(red: 0.08, green: 0.24, blue: 0.13) : Color(red: 0.87, green: 0.96, blue: 0.90)
        default:
            return colorScheme == .dark ? Color(red: 0.24, green: 0.25, blue: 0.28) : Color(red: 0.91, green: 0.92, blue: 0.94)
        }
    }

    var body: some View {
        Text(kind.label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }
}
