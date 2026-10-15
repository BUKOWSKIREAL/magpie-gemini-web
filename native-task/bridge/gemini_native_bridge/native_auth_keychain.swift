// Reads only Gemini Safe Storage through the normal, noninteractive Keychain API,
// then decrypts one caller-selected Gemini auth file. No Frida or App process.
import Foundation
import Security
import LocalAuthentication
import CryptoKit
import Darwin

enum ProbeError: Error { case invalidFormat, keychain(Int32), decryption, output }
struct Field { let number: Int; let integer: UInt64?; let data: Data? }
func fields(_ input: Data) throws -> [Field] {
    let bytes = Array(input); var pos = 0; var result = [Field]()
    func varint() throws -> UInt64 {
        var value: UInt64 = 0
        for shift in stride(from: 0, to: 70, by: 7) {
            guard pos < bytes.count else { throw ProbeError.invalidFormat }
            let byte = bytes[pos]; pos += 1
            if shift == 63 && byte > 1 { throw ProbeError.invalidFormat }
            value |= UInt64(byte & 127) << shift
            if byte < 128 { return value }
        }
        throw ProbeError.invalidFormat
    }
    while pos < bytes.count {
        let key = try varint(); let number = Int(key >> 3)
        guard number > 0 else { throw ProbeError.invalidFormat }
        if key & 7 == 0 {
            result.append(Field(number: number, integer: try varint(), data: nil))
        } else if key & 7 == 2 {
            let size = try varint()
            guard size <= UInt64(bytes.count - pos) else { throw ProbeError.invalidFormat }
            result.append(Field(number: number, integer: nil, data: Data(bytes[pos..<pos+Int(size)])))
            pos += Int(size)
        } else { throw ProbeError.invalidFormat }
    }
    return result
}
func one(_ fs: [Field], _ number: Int) throws -> Field {
    let found = fs.filter { $0.number == number }
    guard found.count == 1 else { throw ProbeError.invalidFormat }
    return found[0]
}
func save(_ path: String, _ data: Data) throws {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
    guard fd >= 0 else { throw ProbeError.output }
    defer { close(fd) }
    var offset = 0
    try data.withUnsafeBytes { bytes in
        while offset < bytes.count {
            let n = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count-offset)
            guard n > 0 else { throw ProbeError.output }
            offset += n
        }
    }
}
var report: [String: Any] = ["success": false, "interaction_allowed": false]
do {
    guard CommandLine.arguments.count == 3 else { throw ProbeError.invalidFormat }
    let context = LAContext(); context.interactionNotAllowed = true
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "Gemini Safe Storage",
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
        kSecUseAuthenticationContext as String: context,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    report["keychain_status"] = status
    guard status == errSecSuccess, let stored = item as? Data else { throw ProbeError.keychain(status) }
    let fs = try fields(stored)
    guard try one(fs, 1).integer == 3735928558 else { throw ProbeError.invalidFormat }
    let keys = try fs.filter { $0.number == 2 }.map { field -> Data in
        guard let data = field.data else { throw ProbeError.invalidFormat }
        let entry = try fields(data)
        guard let key = try one(entry, 4).data, key.count == 32 else { throw ProbeError.invalidFormat }
        return key
    }
    guard !keys.isEmpty && keys.count <= 16 else { throw ProbeError.invalidFormat }
    let encrypted = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let bytes = Array(encrypted)
    guard bytes.count > 28 && bytes.count < 1024*1024,
          Array(bytes[0..<8]) == [0x2e,0xba,0xfe,0xca,0x2e,0xba,0xfe,0xca] else { throw ProbeError.invalidFormat }
    let length = (0..<4).reduce(0) { $0 | Int(bytes[8+$1]) << (8*$1) }
    guard length > 0 && length < 65536 && 12+length < bytes.count else { throw ProbeError.invalidFormat }
    let header = try fields(Data(bytes[12..<12+length]))
    let body = Data(bytes[(12+length)...])
    guard try one(header, 1).integer == 1, try one(header, 2).integer == 1,
          try one(header, 5).integer == UInt64(body.count), body.count > 16,
          let nonce = try one(header, 4).data, nonce.count == 12 else { throw ProbeError.invalidFormat }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                  ciphertext: body.dropLast(16), tag: body.suffix(16))
    var plaintext: Data? = nil
    for key in keys {
        if let decoded = try? AES.GCM.open(box, using: SymmetricKey(data: key)) {
            guard plaintext == nil else { throw ProbeError.invalidFormat }
            plaintext = decoded
        }
    }
    guard let plain = plaintext else { throw ProbeError.decryption }
    _ = try fields(plain)
    try save(CommandLine.arguments[2], plain)
    report["success"] = true
    report["plaintext_bytes"] = plain.count
    report["decryption"] = "AES-256-GCM"
} catch {
    report["error_type"] = String(describing: error)
}
let result = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: result, encoding: .utf8)!)
exit(report["success"] as? Bool == true ? 0 : 2)
