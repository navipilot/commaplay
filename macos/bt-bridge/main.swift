// playport macOS Bluetooth bridge.
//
// Opens an RFCOMM channel to a paired iPhone's iAP2 service and pipes raw bytes between the
// channel and stdin/stdout, so the JVM server can speak the wireless iAP2 bootstrap over a local
// process instead of native code.
//
// Usage:
//   bt-bridge --print-address          print the local Bluetooth adapter address
//   bt-bridge --list                   list paired devices as "AA:BB:CC:DD:EE:FF Name"
//   bt-bridge --address <addr>         open RFCOMM to the device and pump stdio
//
// The iPhone must already be paired in System Settings > Bluetooth.

import Foundation
import IOBluetooth
import Darwin

let iap2UUIDString = "00000000-deca-fade-deca-deafdecacafe"

// macOS TCC stops processes that touch Bluetooth without permission via SIGABRT.
// Turn that silent abort into actionable advice.
signal(SIGABRT) { _ in
    let hint = """
    bt-bridge was stopped by macOS: this process does not have Bluetooth permission.
    Open System Settings > Privacy & Security > Bluetooth and enable your terminal app
    (Terminal, iTerm2, VS Code, Warp, ...), then run the command again.

    """
    FileHandle.standardError.write(hint.data(using: .utf8)!)
    exit(134)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("bt-bridge: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

func normalize(_ address: String) -> String {
    address.replacingOccurrences(of: ":", with: "-").lowercased()
}

/// Runs a blocking IOBluetooth call with a watchdog so missing permissions never hang the helper.
func withTimeout<T>(_ seconds: Double, _ label: String, _ operation: @escaping () -> T?) -> T? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: T?
    DispatchQueue.global().async {
        result = operation()
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + seconds) == .timedOut {
        FileHandle.standardError.write("bt-bridge: \(label) timed out; grant Bluetooth permission to your terminal in System Settings > Privacy & Security > Bluetooth\n".data(using: .utf8)!)
        return nil
    }
    return result
}

func printAddress() {
    let address = withTimeout(3.0, "address lookup") {
        IOBluetoothHostController.default()?.addressAsString()
    }
    guard let address = address else {
        fail("local Bluetooth address unavailable")
    }
    print(address.uppercased().replacingOccurrences(of: "-", with: ":"))
}

func listPaired() {
    let paired = withTimeout(3.0, "paired-device lookup") {
        IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]
    }
    guard let devices = paired else {
        fail("paired device list unavailable")
    }
    for device in devices {
        let address = (device.addressString ?? "").uppercased().replacingOccurrences(of: "-", with: ":")
        let name = device.name ?? ""
        print("\(address) \(name)")
    }
}

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    private var channel: IOBluetoothRFCOMMChannel?

    func start(address: String) {
        guard let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else {
            fail("paired device list unavailable")
        }
        let target = normalize(address)
        guard let device = devices.first(where: { normalize($0.addressString ?? "") == target }) else {
            fail("device \(address) is not paired; pair it in System Settings > Bluetooth first")
        }
        let uuid = IOBluetoothSDPUUID(data: Data(hexUUID: iap2UUIDString))
        let queried = withTimeout(12.0, "SDP query") { device.getServiceRecord(for: uuid) }
        guard let record = queried else {
            fail("the device does not expose the iAP2 service; is it paired and in range?")
        }
        var channelID: BluetoothRFCOMMChannelID = 0
        let channelStatus = record.getRFCOMMChannelID(&channelID)
        guard channelStatus == kIOReturnSuccess else {
            fail("could not read the RFCOMM channel id (status 0x\(String(channelStatus, radix: 16)))")
        }
        var rfcommChannel: IOBluetoothRFCOMMChannel?
        let openStatus = device.openRFCOMMChannelAsync(&rfcommChannel, withChannelID: channelID, delegate: self)
        guard openStatus == kIOReturnSuccess, let opened = rfcommChannel else {
            fail("could not open the RFCOMM channel (status 0x\(String(openStatus, radix: 16)))")
        }
        channel = opened
        FileHandle.standardError.write("bt-bridge: RFCOMM channel \(channelID) opening to \(address)\n".data(using: .utf8)!)
        pumpStdin()
        RunLoop.main.run()
    }

    private func pumpStdin() {
        let input = FileHandle.standardInput
        input.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                FileHandle.standardError.write("bt-bridge: stdin closed\n".data(using: .utf8)!)
                exit(0)
            }
            guard let channel = self.channel else { return }
            var buffer = [UInt8](data)
            let status = channel.writeSync(&buffer, length: UInt16(buffer.count))
            if status != kIOReturnSuccess {
                FileHandle.standardError.write("bt-bridge: write failed 0x\(String(status, radix: 16))\n".data(using: .utf8)!)
            }
        }
    }

    func rfcommChannelOpenComplete(_ sender: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        if error == kIOReturnSuccess {
            FileHandle.standardError.write("bt-bridge: RFCOMM channel open\n".data(using: .utf8)!)
        } else {
            fail("RFCOMM open failed (status 0x\(String(error, radix: 16)))")
        }
    }

    func rfcommChannelData(_ sender: IOBluetoothRFCOMMChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {
        let data = Data(bytes: dataPointer, count: dataLength)
        FileHandle.standardOutput.write(data)
    }

    func rfcommChannelClosed(_ sender: IOBluetoothRFCOMMChannel!) {
        FileHandle.standardError.write("bt-bridge: RFCOMM channel closed\n".data(using: .utf8)!)
        exit(0)
    }
}

extension Data {
    init(hexUUID: String) {
        var bytes = [UInt8]()
        var hex = hexUUID.replacingOccurrences(of: "-", with: "")
        if hex.count == 4 {
            hex = "0000" + hex + "00001000800000805F9B34FB"
        }
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }
}

// MARK: - Inquiry and pairing
//
// macOS hides iPhones from the Bluetooth settings UI (they pair via Continuity), so the helper
// discovers and pairs them through the IOBluetooth API instead. Keep the iPhone's
// Settings > Bluetooth page open while scanning: that is what makes it discoverable.

final class Scanner: NSObject, IOBluetoothDeviceInquiryDelegate {
    private var inquiry: IOBluetoothDeviceInquiry?
    private var seen = Set<String>()

    func start(seconds: UInt8) {
        guard let inquiry = IOBluetoothDeviceInquiry(delegate: self) else {
            fail("could not create a device inquiry")
        }
        self.inquiry = inquiry
        inquiry.inquiryLength = seconds
        inquiry.updateNewDeviceNames = true
        let status = inquiry.start()
        guard status == kIOReturnSuccess else {
            fail("inquiry failed to start (status 0x\(String(status, radix: 16))); grant Bluetooth permission to your terminal")
        }
        FileHandle.standardError.write("bt-bridge: scanning for \(seconds)s — keep the iPhone's Bluetooth settings page open\n".data(using: .utf8)!)
        RunLoop.main.run()
    }

    func deviceInquiryDeviceFound(_ sender: IOBluetoothDeviceInquiry!, device: IOBluetoothDevice!) {
        let address = (device.addressString ?? "").uppercased().replacingOccurrences(of: "-", with: ":")
        guard !address.isEmpty, seen.insert(address).inserted else { return }
        let name = device.name ?? ""
        let kind = device.isPaired() ? "paired" : "new"
        print("\(address) \(name) [\(kind)]")
        fflush(stdout)
    }

    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry!, error: IOReturn, aborted: Bool) {
        if error != kIOReturnSuccess && !aborted {
            fail("inquiry ended with status 0x\(String(error, radix: 16))")
        }
        exit(0)
    }
}

final class Pairer: NSObject, IOBluetoothDevicePairDelegate, IOBluetoothDeviceInquiryDelegate {
    private let target: String
    private let force: Bool
    private var inquiry: IOBluetoothDeviceInquiry?
    private var pairing: IOBluetoothDevicePair?
    private var finished = false

    init(target: String, force: Bool) {
        self.target = target
        self.force = force
    }

    func run() {
        if let device = pairedDevice(matching: target) {
            if !force {
                print("\(target) is already paired; nothing to do.")
                print("Start the server with --wireless and it will find the iPhone (or check --list).")
                exit(0)
            }
            beginPairing(with: device)
            return
        }
        FileHandle.standardError.write(
            "bt-bridge: \(target) is not paired yet; scanning — keep the iPhone's Bluetooth settings page open\n"
                .data(using: .utf8)!,
        )
        guard let inquiry = IOBluetoothDeviceInquiry(delegate: self) else {
            fail("could not create a device inquiry")
        }
        self.inquiry = inquiry
        inquiry.inquiryLength = 20
        inquiry.updateNewDeviceNames = true
        guard inquiry.start() == kIOReturnSuccess else {
            fail("inquiry failed to start; grant Bluetooth permission to your terminal")
        }
        RunLoop.main.run()
    }

    private func pairedDevice(matching address: String) -> IOBluetoothDevice? {
        guard let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else { return nil }
        let normalized = normalize(address)
        return devices.first { normalize($0.addressString ?? "") == normalized }
    }

    private func beginPairing(with device: IOBluetoothDevice) {
        inquiry?.stop()
        inquiry = nil
        guard let pairing = IOBluetoothDevicePair(device: device) else {
            fail("could not create a pairing session")
        }
        self.pairing = pairing
        pairing.delegate = self
        let status = pairing.start()
        guard status == kIOReturnSuccess else {
            fail("pairing failed to start (status 0x\(String(status, radix: 16)))")
        }
        FileHandle.standardError.write("bt-bridge: pairing with \(device.addressString ?? target)…\n".data(using: .utf8)!)
        let watchdog = DispatchQueue.global()
        watchdog.asyncAfter(deadline: .now() + 45) {
            if !self.finished {
                fail("pairing timed out after 45s; make sure the iPhone is awake and unlocked with Settings > Bluetooth open, then retry")
            }
        }
        RunLoop.main.run()
    }

    func devicePairingStarted(_ sender: Any!) {
        FileHandle.standardError.write("bt-bridge: pairing started; a code should appear on the iPhone\n".data(using: .utf8)!)
    }

    func devicePairingConnecting(_ sender: Any!) {
        FileHandle.standardError.write("bt-bridge: link connecting…\n".data(using: .utf8)!)
    }

    func deviceInquiryDeviceFound(_ sender: IOBluetoothDeviceInquiry!, device: IOBluetoothDevice!) {
        guard normalize(device.addressString ?? "") == normalize(target) else { return }
        beginPairing(with: device)
    }

    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry!, error: IOReturn, aborted: Bool) {
        if pairing == nil {
            fail("device \(target) was not found; make sure it is discoverable (Bluetooth settings open) and try again")
        }
    }

    func devicePairingUserConfirmationRequest(_ sender: Any!, numericValue: BluetoothNumericValue) {
        let code = String(format: "%06u", numericValue)
        print("confirm this code on the iPhone: \(code)")
        fflush(stdout)
        pairing?.replyUserConfirmation(true)
    }

    func devicePairingUserPasskeyNotification(_ sender: Any!, passkey: BluetoothPasskey) {
        print("enter this passkey on the iPhone: \(String(format: "%06u", passkey))")
        fflush(stdout)
    }

    func devicePairingPINCodeRequest(_ sender: Any!) {
        // Legacy PIN path; modern iPhones use numeric comparison and never reach this.
        fail("the device requested a legacy PIN code; this helper supports numeric pairing only")
    }

    func devicePairingFinished(_ sender: Any!, error: IOReturn) {
        finished = true
        if error == kIOReturnSuccess {
            print("paired with \(target)")
            exit(0)
        }
        fail("pairing finished with status 0x\(String(error, radix: 16)); remove any stale pairing and retry")
    }
}

let args = CommandLine.arguments
if args.contains("--print-address") {
    printAddress()
} else if args.contains("--list") {
    listPaired()
} else if args.contains("--scan") {
    Scanner().start(seconds: 10)
} else if let index = args.firstIndex(of: "--pair"), index + 1 < args.count {
    Pairer(target: args[index + 1], force: false).run()
} else if let index = args.firstIndex(of: "--force-pair"), index + 1 < args.count {
    Pairer(target: args[index + 1], force: true).run()
} else if let index = args.firstIndex(of: "--address"), index + 1 < args.count {
    Bridge().start(address: args[index + 1])
} else {
    fail("usage: bt-bridge --print-address | --list | --scan | --pair <addr> | --force-pair <addr> | --address <addr>")
}
