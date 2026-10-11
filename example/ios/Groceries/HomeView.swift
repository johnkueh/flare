import SwiftUI

/// Your lists, a new one or an invite code, and the account.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var path: [AppModel.SavedList] = []
    @State private var newName = ""
    @State private var inviteCode = ""
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section("Your lists") {
                    if app.lists.isEmpty {
                        Text("No lists yet.").foregroundStyle(.secondary)
                    }
                    ForEach(app.lists) { list in
                        NavigationLink(list.name, value: list)
                    }
                }

                Section("New list") {
                    HStack {
                        TextField("New list name", text: $newName)
                            .accessibilityIdentifier("new-list-name")
                        Button("Create") {
                            Task {
                                if let list = await app.create(name: newName) {
                                    newName = ""
                                    path = [list]
                                }
                            }
                        }
                        .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    HStack {
                        TextField("Invite code", text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("invite-code-field")
                        Button("Join") {
                            Task {
                                if let list = await app.join(code: inviteCode) {
                                    inviteCode = ""
                                    path = [list]
                                }
                            }
                        }
                        .disabled(inviteCode.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                account

                if let error = app.error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .buttonStyle(.borderless)
            .navigationTitle("Groceries")
            .navigationDestination(for: AppModel.SavedList.self) { list in
                ListView(list: list)
            }
            .task { await app.refresh() }
            .refreshable { await app.refresh() }
        }
    }

    @ViewBuilder private var account: some View {
        if let signedIn = app.email {
            Section("Account") {
                LabeledContent("Signed in", value: signedIn)
                Button("Sign out", role: .destructive) {
                    Task { await app.signOut() }
                }
            }
        } else {
            Section {
                HStack {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("email")
                    Button("Send code") {
                        Task { codeSent = await app.sendCode(to: email) }
                    }
                    .disabled(!email.contains("@"))
                }
                if codeSent {
                    HStack {
                        TextField("6-digit code", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("email-code")
                        Button("Sign in") {
                            Task {
                                if await app.signIn(email: email, code: code.trimmingCharacters(in: .whitespaces)) {
                                    code = ""
                                    codeSent = false
                                }
                            }
                        }
                        .disabled(code.isEmpty)
                    }
                }
            } header: {
                Text("Account")
            } footer: {
                Text("You're signed in anonymously on this phone. Sign in with an email code to keep your lists on an account and open them anywhere.")
            }
        }
    }
}
