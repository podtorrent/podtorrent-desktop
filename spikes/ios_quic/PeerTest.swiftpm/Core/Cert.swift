// Identities and certificates. Apple's TLS can't sign with Ed25519, so the QUIC certificate gets an
// ephemeral P-256 key, and an extension (IDENTITY_EXT in podtorrent/net/quic.py) carries the Ed25519
// identity key plus its signature over b"podtorrent-tls|" + the P-256 point.
import CryptoKit
import Foundation
import Security

struct PeerIdentity {
    let key: Curve25519.Signing.PrivateKey
    var peerId: String { peerIdOf(key.publicKey.rawRepresentation) }

    /// A fresh identity whose peer_id starts with `prefix`. The smaller peer_id dials, and today's peers
    /// serve Ed25519 certificates that Apple's TLS can't verify, so the test peer sorts last and gets dialed.
    static func generate(prefix: String = "") -> PeerIdentity {
        while true {
            let id = PeerIdentity(key: Curve25519.Signing.PrivateKey())
            if id.peerId.hasPrefix(prefix) { return id }
        }
    }

    func sign(_ s: String) throws -> Data { try key.signature(for: Data(s.utf8)) }
}

/// OID 1.3.6.1.4.1.53594.77.1 as DER (tag, length, body).
let identityExtOID: [UInt8] = [0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xa2, 0x5a, 0x4d, 0x01]

/// The Ed25519 key a server certificate proves: its own key, or the one in the identity extension
/// whose signature covers the certificate's P-256 key.
func certIdentityKey(_ cert: SecCertificate) -> Data? {
    let b = [UInt8](SecCertificateCopyData(cert) as Data)
    let ed: [UInt8] = [0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]   // SPKI: OID 1.3.101.112, BIT STRING
    if let i = find(ed, in: b), i + ed.count + 32 <= b.count { return Data(b[(i + ed.count)..<(i + ed.count + 32)]) }
    let want = identityExtOID + [0x04, 0x60]
    guard let i = find(want, in: b), i + want.count + 96 <= b.count, let leaf = SecCertificateCopyKey(cert),
          let point = SecKeyCopyExternalRepresentation(leaf, nil) as Data? else { return nil }
    let proof = Data(b[(i + want.count)..<(i + want.count + 96)])
    guard let k = try? Curve25519.Signing.PublicKey(rawRepresentation: proof.prefix(32)),
          k.isValidSignature(proof.suffix(64), for: Data("podtorrent-tls|".utf8) + point) else { return nil }
    return proof.prefix(32)
}

private func find(_ needle: [UInt8], in hay: [UInt8]) -> Int? {
    guard hay.count >= needle.count else { return nil }
    return (0...(hay.count - needle.count)).first { hay[$0..<$0 + needle.count].elementsEqual(needle) }
}

// ---- a self-signed P-256 certificate carrying the identity, as a SecIdentity for Network.framework ----
private enum DER {
    static func tlv(_ tag: UInt8, _ body: [UInt8]) -> [UInt8] { [tag] + length(body.count) + body }
    static func length(_ n: Int) -> [UInt8] {
        if n < 0x80 { return [UInt8(n)] }
        var b: [UInt8] = [], x = n
        while x > 0 { b.insert(UInt8(x & 0xff), at: 0); x >>= 8 }
        return [0x80 | UInt8(b.count)] + b
    }
    static func seq(_ parts: [UInt8]...) -> [UInt8] { tlv(0x30, parts.flatMap { $0 }) }
    static func set(_ parts: [UInt8]...) -> [UInt8] { tlv(0x31, parts.flatMap { $0 }) }
    static func int(_ b: [UInt8]) -> [UInt8] { tlv(0x02, b.first.map { $0 & 0x80 != 0 } == true ? [0] + b : b) }
    static func oid(_ arcs: [UInt]) -> [UInt8] {
        var body: [UInt8] = [UInt8(arcs[0] * 40 + arcs[1])]
        for var a in arcs.dropFirst(2) {
            var chunk: [UInt8] = [UInt8(a & 0x7f)]
            a >>= 7
            while a > 0 { chunk.insert(UInt8(a & 0x7f) | 0x80, at: 0); a >>= 7 }
            body += chunk
        }
        return tlv(0x06, body)
    }
    static func utf8(_ s: String) -> [UInt8] { tlv(0x0c, Array(s.utf8)) }
    static func time(_ d: Date) -> [UInt8] {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, Array(f.string(from: d).utf8))
    }
    static func bits(_ b: [UInt8]) -> [UInt8] { tlv(0x03, [0] + b) }
    static func octets(_ b: [UInt8]) -> [UInt8] { tlv(0x04, b) }
    static func explicit(_ n: UInt8, _ b: [UInt8]) -> [UInt8] { tlv(0xa0 | n, b) }
}

enum TLSIdentity {
    static let label = "PodTorrent test peer"

    static func make(for ident: PeerIdentity) throws -> SecIdentity {
        let key = P256.Signing.PrivateKey()
        let point = key.publicKey.x963Representation
        let proof = ident.key.publicKey.rawRepresentation + (try ident.key.signature(for: Data("podtorrent-tls|".utf8) + point))
        let ecdsaSHA256 = DER.seq(DER.oid([1, 2, 840, 10045, 4, 3, 2]))
        let name = DER.seq(DER.set(DER.seq(DER.oid([2, 5, 4, 3]), DER.utf8(ident.peerId))))
        let serial = (0..<8).map { _ in UInt8.random(in: 0...255) }
        let tbs = DER.seq(
            DER.explicit(0, DER.int([2])),
            DER.int([serial[0] & 0x7f] + serial.dropFirst()),
            ecdsaSHA256,
            name,
            DER.seq(DER.time(Date().addingTimeInterval(-86_400)), DER.time(Date().addingTimeInterval(30 * 86_400))),
            name,
            DER.seq(DER.seq(DER.oid([1, 2, 840, 10045, 2, 1]), DER.oid([1, 2, 840, 10045, 3, 1, 7])), DER.bits(Array(point))),
            DER.explicit(3, DER.seq(DER.seq(identityExtOID, DER.octets(Array(proof))))))
        let sig = try key.signature(for: Data(tbs)).derRepresentation
        let der = DER.seq(tbs, ecdsaSHA256, DER.bits(Array(sig)))

        guard let cert = SecCertificateCreateWithData(nil, Data(der) as CFData) else { throw WireError("bad certificate DER") }

        // Network.framework takes a SecIdentity, which only a keychain can pair up from a key and a cert.
        #if os(macOS)
        return try macIdentity(key: key, cert: cert)
        #else
        var err: Unmanaged<CFError>?
        guard let secKey = SecKeyCreateWithData(key.x963Representation as CFData, [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate,
        ] as CFDictionary, &err) else { throw WireError("SecKeyCreateWithData: \(err!.takeRetainedValue())") }
        removeOld()
        var st = SecItemAdd([kSecClass: kSecClassKey, kSecValueRef: secKey, kSecAttrLabel: label] as CFDictionary, nil)
        guard st == errSecSuccess else { throw WireError("keychain add key: \(st)") }
        st = SecItemAdd([kSecClass: kSecClassCertificate, kSecValueRef: cert, kSecAttrLabel: label] as CFDictionary, nil)
        guard st == errSecSuccess else { throw WireError("keychain add certificate: \(st)") }
        var found: CFTypeRef?
        st = SecItemCopyMatching([kSecClass: kSecClassIdentity, kSecReturnRef: true, kSecMatchLimit: kSecMatchLimitAll] as CFDictionary, &found)
        for any in (found as? [Any]) ?? [] {
            let id = any as! SecIdentity
            var c: SecCertificate?
            if SecIdentityCopyCertificate(id, &c) == errSecSuccess, let c, SecCertificateCopyData(c) == SecCertificateCopyData(cert) { return id }
        }
        throw WireError("identity not found in keychain (\(st))")
        #endif
    }

    #if os(macOS)
    /// The macOS test CLI has no keychain entitlement, so it uses a throwaway file keychain.
    private static func macIdentity(key: P256.Signing.PrivateKey, cert: SecCertificate) throws -> SecIdentity {
        let path = NSTemporaryDirectory() + "podtorrent-test-\(getpid()).keychain"
        try? FileManager.default.removeItem(atPath: path)
        var kc: SecKeychain?
        var st = SecKeychainCreate(path, 4, "test", false, nil, &kc)
        guard st == errSecSuccess, let kc else { throw WireError("SecKeychainCreate: \(st)") }
        atexit_b { try? FileManager.default.removeItem(atPath: path) }
        // SEC1 ECPrivateKey (what OpenSSL calls "EC PRIVATE KEY"): the one EC format SecItemImport reads.
        let sec1 = DER.seq(DER.int([1]), DER.octets(Array(key.rawRepresentation)),
                           DER.explicit(0, DER.oid([1, 2, 840, 10045, 3, 1, 7])),
                           DER.explicit(1, DER.bits(Array(key.publicKey.x963Representation))))
        var format = SecExternalFormat.formatOpenSSL, type = SecExternalItemType.itemTypePrivateKey
        var params = SecItemImportExportKeyParameters()
        params.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
        st = SecItemImport(Data(sec1) as CFData, nil, &format, &type, [], &params, kc, nil)
        guard st == errSecSuccess else { throw WireError("SecItemImport key: \(st)") }
        st = SecCertificateAddToKeychain(cert, kc)
        guard st == errSecSuccess else { throw WireError("SecCertificateAddToKeychain: \(st)") }
        var identity: SecIdentity?
        st = SecIdentityCreateWithCertificate(kc, cert, &identity)
        guard st == errSecSuccess, let identity else { throw WireError("SecIdentityCreateWithCertificate: \(st)") }
        return identity
    }
    #endif

    /// Certificates and keys from earlier runs.
    static func removeOld() {
        #if !os(macOS)
        for cls in [kSecClassCertificate, kSecClassKey] {
            while SecItemDelete([kSecClass: cls, kSecAttrLabel: label] as CFDictionary) == errSecSuccess {}
        }
        #endif
    }
}
