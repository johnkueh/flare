import SwiftUI
import SyncClient
import SyncKit

/// One list: its items, the invite code and who's in it.
struct ListView: View {
    let list: AppModel.SavedList
    @Environment(AppModel.self) private var app
    @State private var model: ListModel?
    @State private var newItem = ""
    @State private var failed: String?

    var body: some View {
        Form {
            if let model {
                Section {
                    HStack {
                        TextField("Add an item", text: $newItem)
                            .accessibilityIdentifier("new-item")
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    ForEach(model.items) { item in
                        Button {
                            model.toggle(item)
                        } label: {
                            HStack {
                                Image(systemName: item.done == true ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(item.done == true ? Color.accentColor : .secondary)
                                Text(item.name ?? "")
                                    .strikethrough(item.done == true)
                                    .foregroundStyle(item.done == true ? .secondary : .primary)
                            }
                        }
                        .accessibilityLabel("\(item.name ?? ""), \(item.done == true ? "done" : "not done")")
                    }
                } footer: {
                    if let error = model.error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text(model.isLive ? "Live" : "Connecting…")
                    }
                }

                if let info = model.info {
                    Section("Invite code") {
                        Text(formatInvite(code: info.code))
                            .font(.title3.monospaced().weight(.semibold))
                            .textSelection(.enabled)
                            .accessibilityIdentifier("invite-code")
                    }
                    Section("Members") {
                        ForEach(info.devices, id: \.id) { member in
                            VStack(alignment: .leading, spacing: 2) {
                                Text((member.id == info.you ? "You" : "Member") + (member.id == info.owner ? " (owner)" : ""))
                                Text(member.devices.map { $0.name.isEmpty ? $0.platform : $0.name }.joined(separator: ", "))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else if let failed {
                Text(failed).foregroundStyle(.red)
            }
        }
        .buttonStyle(.borderless)
        .navigationTitle(list.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            model?.sync()
            await model?.loadInfo()
        }
        .task {
            do {
                let model = try ListModel(spaceID: list.id, client: app.client)
                self.model = model
                model.start()
            } catch {
                failed = error.localizedDescription
            }
        }
        .onDisappear { model?.stop() }
    }

    private func add() {
        let name = newItem.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        model?.add(name)
        newItem = ""
    }
}
