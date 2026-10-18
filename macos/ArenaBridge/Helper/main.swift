import Foundation
import Dispatch

// The helper that starts the bridge. It lives inside the signed app bundle, so
// macOS gives the screen and the accessibility permissions to the app that
// starts the request and the system settings show the app name and not the
// name of the node binary.
//
//   arena-bridge-agent <command> [arguments...]

var signalSources: [DispatchSourceSignal] = []

let arguments = CommandLine.arguments
guard arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: arena-bridge-agent <command> [arguments...]\n".utf8))
    exit(64)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: arguments[1])
child.arguments = Array(arguments.dropFirst(2))
child.environment = ProcessInfo.processInfo.environment
child.standardInput = FileHandle.nullDevice
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError

do {
    try child.run()
} catch {
    FileHandle.standardError.write(Data("arena-bridge-agent: cannot start \(arguments[1])\n".utf8))
    exit(70)
}

// The service manager stops the helper, the helper stops the bridge.
let childProcess = child
for number in [SIGTERM, SIGINT] {
    let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
    source.setEventHandler { childProcess.terminate() }
    source.resume()
    signalSources.append(source)
}

child.waitUntilExit()

// The service manager restarts the service, so the code of the bridge is the
// code of the helper.
if child.terminationReason == .uncaughtSignal {
    exit(128 + child.terminationStatus)
}
exit(child.terminationStatus)
