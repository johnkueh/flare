// The JSON bodies of the /spaces calls (PROTOCOL.md, "HTTP"); the server
// builds them in server/src/space.ts and server/src/spaces.ts. First
// generated from an OpenAPI contract, now kept by hand: change them
// with the server, in the same commit.

import Foundation

/// A space as the server describes it (`Info` in PROTOCOL.md).
public struct SpaceInfo: Codable, Sendable, Hashable {
    /// A device in the space. Times are milliseconds since 1970.
    public struct Device: Codable, Sendable, Hashable {
        public var id: String
        public var name: String
        public var platform: String
        public var joinedAt: Int
        public var lastSeen: Int

        public init(id: String, name: String, platform: String, joinedAt: Int = 0, lastSeen: Int = 0) {
            self.id = id
            self.name = name
            self.platform = platform
            self.joinedAt = joinedAt
            self.lastSeen = lastSeen
        }

        private enum CodingKeys: String, CodingKey { case id, name, platform, joinedAt, lastSeen }
    }

    public var spaceId: String
    public var name: String
    public var code: String
    public var owner: String
    public var you: String
    public var version: Int
    public var time: Int
    public var devices: [SpaceInfo.Device]

    public init(spaceId: String, name: String, code: String, owner: String, you: String, version: Int = 0, time: Int = 0, devices: [SpaceInfo.Device] = []) {
        self.spaceId = spaceId
        self.name = name
        self.code = code
        self.owner = owner
        self.you = you
        self.version = version
        self.time = time
        self.devices = devices
    }

    private enum CodingKeys: String, CodingKey { case spaceId, name, code, owner, you, version, time, devices }
}

/// What an invite code would join.
public struct InvitePreview: Codable, Sendable, Hashable {
    public var spaceId: String
    public var name: String
    public var devices: Int
    public var collections: [String: Int]
    public var time: Int

    public init(spaceId: String, name: String, devices: Int = 0, collections: [String: Int] = [:], time: Int = 0) {
        self.spaceId = spaceId
        self.name = name
        self.devices = devices
        self.collections = collections
        self.time = time
    }

    private enum CodingKeys: String, CodingKey { case spaceId, name, devices, collections, time }
}

/// `POST /spaces`.
public struct NewSpace: Codable, Sendable, Hashable {
    public var name: String
    public var deviceName: String
    public var platform: String

    public init(name: String, deviceName: String, platform: String) {
        self.name = name
        self.deviceName = deviceName
        self.platform = platform
    }
}

/// `POST /spaces/{spaceId}/join`.
public struct JoinSpace: Codable, Sendable, Hashable {
    public var code: String
    public var deviceName: String
    public var platform: String

    public init(code: String, deviceName: String, platform: String) {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
    }
}

extension SpaceInfo.Device {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        platform = try container.decode(String.self, forKey: .platform)
        joinedAt = try container.decodeIfPresent(Int.self, forKey: .joinedAt) ?? 0
        lastSeen = try container.decodeIfPresent(Int.self, forKey: .lastSeen) ?? 0
    }
}

extension SpaceInfo {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = try container.decode(String.self, forKey: .spaceId)
        name = try container.decode(String.self, forKey: .name)
        code = try container.decode(String.self, forKey: .code)
        owner = try container.decode(String.self, forKey: .owner)
        you = try container.decode(String.self, forKey: .you)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
        time = try container.decodeIfPresent(Int.self, forKey: .time) ?? 0
        devices = try container.decodeIfPresent([SpaceInfo.Device].self, forKey: .devices) ?? []
    }
}

extension InvitePreview {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = try container.decode(String.self, forKey: .spaceId)
        name = try container.decode(String.self, forKey: .name)
        devices = try container.decodeIfPresent(Int.self, forKey: .devices) ?? 0
        collections = try container.decodeIfPresent([String: Int].self, forKey: .collections) ?? [:]
        time = try container.decodeIfPresent(Int.self, forKey: .time) ?? 0
    }
}
