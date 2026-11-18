import Foundation
import Security

struct RefreshKeychain: LoginKeychain {
    let origin: URL

    // The default application access group is stable for in-place updates on the same team.
    private var item: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: "com.commonswarm.ios.auth",
         kSecAttrAccount: origin.absoluteString,
         kSecAttrSynchronizable: false]
    }

    private struct StorageError: Error { let status: OSStatus }

    func read() throws -> SavedLogin? {
        var query = item
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecInteractionNotAllowed { throw SessionStorageError.locked }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StorageError(status: status) }
        return try JSONDecoder().decode(SavedLogin.self, from: data)
    }

    func save(_ login: SavedLogin) throws {
        let values: [CFString: Any] = [kSecValueData: try JSONEncoder().encode(login),
                                       kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(item as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let newItem = item.merging(values) { _, value in value }
            status = SecItemAdd(newItem as CFDictionary, nil)
        }
        if status == errSecInteractionNotAllowed { throw SessionStorageError.locked }
        guard status == errSecSuccess else { throw StorageError(status: status) }
    }

    func remove() throws {
        let status = SecItemDelete(item as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError(status: status) }
    }
}
