import Foundation

/// A JSON value that keeps integers, booleans and strings apart, so rosters re-encode to the same bytes
/// as pod.canonical in Python. Floats are refused when encoding canonically: languages print them differently.
public enum JSON: Equatable, Sendable {
    case null, bool(Bool), int(Int), double(Double), string(String), array([JSON]), object([String: JSON])

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var int: Int? { if case .int(let i) = self { return i }; return nil }
    public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
}

extension JSON: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public static func parse(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
    public static func parse(_ text: String) throws -> JSON { try parse(Data(text.utf8)) }
}

/// Sorted keys (by code point, as Python sorts), no whitespace, UTF-8, `/` not escaped: Python's
/// `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
public func canonical(_ v: JSON) throws -> String {
    var out = ""
    try write(v, &out)
    return out
}

private func write(_ v: JSON, _ out: inout String) throws {
    switch v {
    case .null: out += "null"
    case .bool(let b): out += b ? "true" : "false"
    case .int(let i): out += String(i)
    case .double: throw RosterError.badValue
    case .string(let s): quote(s, &out)
    case .array(let a):
        out += "["
        for (i, x) in a.enumerated() { if i > 0 { out += "," }; try write(x, &out) }
        out += "]"
    case .object(let o):
        out += "{"
        let keys = o.keys.sorted { Array($0.unicodeScalars.map(\.value)).lexicographicallyPrecedes($1.unicodeScalars.map(\.value)) }
        for (i, k) in keys.enumerated() {
            if i > 0 { out += "," }
            quote(k, &out)
            out += ":"
            try write(o[k]!, &out)
        }
        out += "}"
    }
}

private func quote(_ s: String, _ out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        default:
            if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
        }
    }
    out += "\""
}
