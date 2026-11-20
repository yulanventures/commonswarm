import SwiftUI

struct MemberChoiceLabel: View {
    let choice: MemberChoice
    let detail: String?

    var body: some View {
        Label {
            VStack(alignment: .leading) {
                Text(choice.name)
                if let detail { Text(detail).font(.caption) }
            }
            .foregroundStyle(Color(uiColor: .label))
        } icon: {
            Image(systemName: choice.id.kind == .agent ? "cpu" : "person")
        }
    }
}
