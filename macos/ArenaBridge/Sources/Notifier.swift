import Foundation
import OSLog
import UserNotifications

/// Local notifications for the moments the user must not miss.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private override init() { super.init() }

    /// Ask for the permission once; a refusal simply means no notifications.
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Whether macOS lets the app show notifications.
    func allowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    func post(title: String, body: String) {
        Logger(subsystem: AppInfo.bundleID, category: "notifier").notice("posted: \(title)")
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    /// Show the banner even while the app is in front.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                           willPresent notification: UNNotification,
                                           withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Logger(subsystem: AppInfo.bundleID, category: "notifier").notice("willPresent: showing the banner")
        completionHandler([.banner, .sound, .list])
    }
}
