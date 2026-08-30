import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Daily usage source fallback")
struct DailyUsageFallbackTests {
  @Test("router telemetry fills only dates absent from the account stream")
  func accountBucketsRemainAuthoritative() {
    let merged = mergeAccountUsageBuckets(
      account: [
        CodexDailyUsageBucket(startDate: "2026-08-26", tokens: 260),
        CodexDailyUsageBucket(startDate: "2026-08-28", tokens: 280),
      ],
      router: [
        ProviderDailyUsageBucket(startDate: "2026-08-27", tokens: 27_000, requests: 3),
        ProviderDailyUsageBucket(startDate: "2026-08-28", tokens: 99_999, requests: 4),
      ]
    )

    #expect(merged == [
      DailyUsageDisplayBucket(startDate: "2026-08-26", tokens: 260, isRouterFallback: false),
      DailyUsageDisplayBucket(startDate: "2026-08-27", tokens: 27_000, isRouterFallback: true),
      DailyUsageDisplayBucket(startDate: "2026-08-28", tokens: 280, isRouterFallback: false),
    ])
  }

  @Test("an explicit zero account bucket is not replaced by local traffic")
  func explicitZeroWins() {
    let merged = mergeAccountUsageBuckets(
      account: [CodexDailyUsageBucket(startDate: "2026-08-27", tokens: 0)],
      router: [ProviderDailyUsageBucket(startDate: "2026-08-27", tokens: 27_000, requests: 3)]
    )

    #expect(merged == [
      DailyUsageDisplayBucket(startDate: "2026-08-27", tokens: 0, isRouterFallback: false),
    ])
  }

  @Test("widget projection never publishes local fallback as account usage")
  func widgetProjectionExcludesFallbackTokens() {
    let accountDate = Date(timeIntervalSince1970: 1_777_500_000)
    let fallbackDate = accountDate.addingTimeInterval(86_400)
    let projected = routerWidgetDailyPoints([
      DailyUsagePoint(date: accountDate, tokens: 280, isRouterFallback: false),
      DailyUsagePoint(date: fallbackDate, tokens: 27_000, isRouterFallback: true),
    ])

    #expect(projected == [
      RouterWidgetDailyPoint(date: accountDate, tokens: 280),
      RouterWidgetDailyPoint(date: fallbackDate, tokens: 0),
    ])
  }
}
