import Foundation
import Observation
import SyncClient
import SyncKit
import UIKit

/// Who's signed in and which lists they have.
@MainActor
@Observable
final class AppModel {
    /// The Worker in `example/`. Pass `-server https://…` as a launch
    /// argument to use a deployed one.
    static let server = URL(string: UserDefaults.standard.string(forKey: "server") ?? "http://localhost:8787")!

    let auth: FlareAuth
    let client: SpaceClient

    private(set) var lists: [SavedList] = []
    /// The account's email, or nil while the user is anonymous.
    private(set) var email: String?
    private(set) var userID: String?
    var error: String?

    struct SavedList: Codable, Identifiable, Hashable {
        var id: String
        var name: String
    }

    init() {
        // The simulator has no App Attest, so FlareAuth signs in unattested
        // there by itself (the server needs FLARE_AUTH_ALLOW_UNATTESTED).
        auth = FlareAuth(baseURL: Self.server.appending(path: "v1/auth"))
        client = SpaceClient(baseURL: Self.server.appending(path: "v1"), deviceName: UIDevice.current.name, tokens: auth)
        email = UserDefaults.standard.string(forKey: "email")
        if let saved = UserDefaults.standard.data(forKey: "lists") {
            lists = (try? JSONDecoder().decode([SavedList].self, from: saved)) ?? []
        }
    }

    /// The lists this user is in, from the server. The first call signs in
    /// anonymously. Offline, the saved ones stay.
    func refresh() async {
        struct Me: Decodable {
            var user: String
            var spaces: [SpaceInfo]
        }
        do {
            var request = URLRequest(url: Self.server.appending(path: "v1/me/spaces"))
            request.setValue("Bearer \(try await auth.token())", forHTTPHeaderField: "Authorization")
            request.setValue("ios", forHTTPHeaderField: "X-Device-Platform")
            request.setValue(UIDevice.current.name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed), forHTTPHeaderField: "X-Device-Name")
            let (data, response) = try await URLSession.shared.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 401 {
                // The session ended on the server: start again as a new user.
                auth.clear()
                email = nil
                UserDefaults.standard.removeObject(forKey: "email")
                return await refresh()
            }
            let me = try JSONDecoder().decode(Me.self, from: data)
            userID = me.user
            save(me.spaces.map { SavedList(id: $0.spaceId, name: $0.name) })
            error = nil
        } catch {
            self.error = "Can't reach \(Self.server.host() ?? "the server"). \(error.localizedDescription)"
        }
    }

    func create(name: String) async -> SavedList? {
        await adding { try await client.create(name: name, deviceName: UIDevice.current.name) }
    }

    /// Joins with an invite code as typed or pasted (`7KQ2-M9XD`, or a link).
    func join(code text: String) async -> SavedList? {
        guard let code = parseInvite(text: text) else {
            error = "That doesn't look like an invite code."
            return nil
        }
        return await adding {
            let preview = try await client.preview(code: code)
            return try await client.join(spaceID: preview.spaceId, code: code, deviceName: UIDevice.current.name)
        }
    }

    private func adding(_ work: () async throws -> SpaceInfo) async -> SavedList? {
        do {
            let info = try await work()
            let list = SavedList(id: info.spaceId, name: info.name)
            save(lists.filter { $0.id != list.id } + [list])
            error = nil
            return list
        } catch let error as SpaceServerError where error.code == "NOT_FOUND" {
            self.error = "No list has that code."
        } catch {
            self.error = error.localizedDescription
        }
        return nil
    }

    // MARK: Account

    func sendCode(to email: String) async -> Bool {
        do {
            try await auth.sendEmailCode(email)
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Signs in to an account. The anonymous user's lists move to it on the
    /// server (`relinkMember`), so they're still here afterwards.
    func signIn(email: String, code: String) async -> Bool {
        do {
            try await auth.signInWithEmailCode(email: email, code: code)
            self.email = email
            UserDefaults.standard.set(email, forKey: "email")
            await refresh()
            return true
        } catch {
            self.error = "That code didn't work. Check it, or send a new one."
            return false
        }
    }

    /// Back to a new anonymous user, with no lists.
    func signOut() async {
        await auth.signOut()
        email = nil
        UserDefaults.standard.removeObject(forKey: "email")
        for list in lists { ListModel.forget(list.id) }
        save([])
        await refresh()
    }

    private func save(_ lists: [SavedList]) {
        self.lists = lists
        UserDefaults.standard.set(try? JSONEncoder().encode(lists), forKey: "lists")
    }
}
