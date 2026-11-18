import SwiftUI

struct ConversationComposer: View {
    @ObservedObject var draft: Composer
    let destination: String
    let send: () -> Void

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    private let fieldShape = RoundedRectangle(cornerRadius: 22, style: .continuous)
    private var solid: Bool { reduceTransparency || contrast == .increased }

    var body: some View {
        Group {
            if #available(iOS 26, *), !solid {
                GlassEffectContainer(spacing: 4) {
                    HStack(alignment: .bottom, spacing: 8) {
                        entry.glassEffect(.regular, in: fieldShape)
                        sendButton.buttonStyle(.glassProminent).buttonBorderShape(.circle)
                    }
                }
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    entry.background(fallbackFill, in: fieldShape)
                        .overlay { fieldShape.strokeBorder(.secondary, lineWidth: solid ? 1 : 0) }
                    sendButton.buttonStyle(.borderedProminent).buttonBorderShape(.circle)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    private var fallbackFill: AnyShapeStyle {
        solid ? AnyShapeStyle(Color(uiColor: .systemBackground)) : AnyShapeStyle(.regularMaterial)
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let failure = draft.failure, !draft.sending {
                Text(failure == .unconfirmed ? "Delivery unconfirmed" : "Couldn’t send message")
                Button("Retry", action: send)
            }
            let label = "Message " + destination
            ZStack(alignment: .leading) {
                if draft.text.isEmpty {
                    Text(label).foregroundStyle(.primary.opacity(0.78))
                        .accessibilityHidden(true).allowsHitTesting(false)
                }
                TextField(label, text: $draft.text, prompt: Text(""), axis: .vertical)
                    .lineLimit(1...5).textFieldStyle(.plain)
                    .accessibilityLabel(Text(label))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 44)
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up").font(.headline)
                .frame(minWidth: 28, minHeight: 32)
        }
        .accessibilityLabel("Send message")
        .disabled(draft.sending || draft.submission != nil ||
                  draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.text.utf16.count > 8_000)
    }

}

struct JumpToLatestButton: View {
    let action: () -> Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        if #available(iOS 26, *), !solid {
            button.buttonStyle(.glass).buttonBorderShape(.capsule)
        } else {
            button.buttonStyle(.plain).padding(.horizontal, 12)
                .background(solid ? AnyShapeStyle(Color(uiColor: .systemBackground)) : AnyShapeStyle(.regularMaterial), in: Capsule())
                .overlay { Capsule().strokeBorder(.secondary, lineWidth: solid ? 1 : 0) }
        }
    }

    private var solid: Bool { reduceTransparency || contrast == .increased }

    private var button: some View {
        Button(action: action) {
            Label("Latest", systemImage: "arrow.down").font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
        }
        .accessibilityLabel("Jump to latest")
    }
}
