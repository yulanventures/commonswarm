import SwiftUI

struct RetryView: View {
    let text: String
    let action: () async -> Void
    var body: some View {
        VStack { Text(text); Button("Retry") { Task { await action() } } }
    }
}
