// Plain UDP sockets on the QUIC port, for STUN and hole punching. Network.framework won't pin its own UDP
// connections to a reused port, so these are BSD sockets with SO_REUSEPORT, each connect()ed to one remote.
// What the spike found about sharing the port with an NWListener:
//   - once the listener holds the port it receives every datagram, so these sockets can send but not
//     receive: STUN has to run before the listener starts;
//   - while one of these is connected to a peer's address, Network.framework can't answer that address,
//     so a probe socket is opened, used and closed in one go.
import Foundation

final class UDPSocket {
    let fd: Int32
    let remote: String

    /// Bound to `localPort` (alongside the QUIC listener) and connected to host:port (IPv4).
    init(localPort: UInt16, host: String, port: UInt16) throws {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        if inet_pton(AF_INET, host, &addr.sin_addr) != 1 {
            var hints = addrinfo(), res: UnsafeMutablePointer<addrinfo>?
            hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM
            guard getaddrinfo(host, nil, &hints, &res) == 0, let r = res else { throw WireError("can't resolve \(host)") }
            addr.sin_addr = r.pointee.ai_addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
            freeaddrinfo(res)
        }
        fd = socket(AF_INET, SOCK_DGRAM, 0)
        remote = "\(host):\(port)"
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, 4)
        setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, 4)
        var local = sockaddr_in()
        local.sin_family = sa_family_t(AF_INET)
        local.sin_port = localPort.bigEndian
        let len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } } == 0
            && withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) } } == 0
        if !ok {
            let e = errno
            Darwin.close(fd)
            throw WireError("udp \(remote): \(String(cString: strerror(e)))")
        }
    }

    func send(_ b: [UInt8]) { _ = b.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, b.count, 0) } }

    /// The next datagram, or nil after `timeout` seconds.
    func recv(timeout: Double) -> [UInt8]? {
        var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&p, 1, Int32(timeout * 1000)) > 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: 2048)
        let n = Darwin.recv(fd, &buf, buf.count, 0)
        return n > 0 ? Array(buf[0..<n]) : nil
    }

    func close() { Darwin.close(fd) }
}

/// This socket's public ip:port as a STUN server sees it (RFC 5389 binding request).
func stun(localPort: UInt16) -> (String, UInt16)? {
    for (host, port) in [("stun.cloudflare.com", UInt16(3478)), ("stun.l.google.com", 19302)] {
        guard let s = try? UDPSocket(localPort: localPort, host: host, port: port) else { continue }
        defer { s.close() }
        let txn = (0..<12).map { _ in UInt8.random(in: 0...255) }
        s.send([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42] + txn)
        guard let r = s.recv(timeout: 2), r.count >= 20, Array(r[8..<20]) == txn else { continue }
        var i = 20
        while i + 4 <= r.count {
            let kind = Int(r[i]) << 8 | Int(r[i + 1]), size = Int(r[i + 2]) << 8 | Int(r[i + 3])
            let v = Array(r[(i + 4)..<min(i + 4 + size, r.count)])
            if (kind == 0x0020 || kind == 0x0001), v.count >= 8, v[1] == 0x01 {   // (XOR-)MAPPED-ADDRESS, IPv4
                let x = kind == 0x0020
                let p = (UInt16(v[2]) << 8 | UInt16(v[3])) ^ (x ? 0x2112 : 0)
                let cookie: [UInt8] = [0x21, 0x12, 0xa4, 0x42]
                let ip = (0..<4).map { String(v[4 + $0] ^ (x ? cookie[$0] : 0)) }.joined(separator: ".")
                return (ip, p)
            }
            i += 4 + (size + 3) / 4 * 4
        }
    }
    return nil
}

/// Private IPv4 addresses on this device, for peers behind the same router.
func lanAddresses() -> [String] {
    var out: [String] = [], head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0 else { return [] }
    defer { freeifaddrs(head) }
    var p = head
    while let ifa = p {
        defer { p = ifa.pointee.ifa_next }
        guard let sa = ifa.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET),
              ifa.pointee.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
        let ip = String(cString: host)
        let octets = ip.split(separator: ".").compactMap { Int($0) }
        if ip.hasPrefix("127.") || ip.hasPrefix("169.254.") || (octets.first == 100 && (64...127).contains(octets[1])) { continue }
        out.append(ip)
    }
    return out
}
