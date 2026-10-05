const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../fxmd_data.js");

// Trimmed copies of real keyless responses from the FXMacroData API.
const calendarBody = {
	currency: "USD",
	timezone: "America/New_York",
	data: [
		{ announcement_datetime: 1791289800, release: "trade_balance", calendar_event_id: "usd_trade_balance_1791289800", name: "Trade Balance", event_importance: "medium" },
		{ announcement_datetime: 1791462600, release: "initial_jobless_claims", calendar_event_id: "usd_initial_jobless_claims_1791462600", name: "Initial Jobless Claims", event_importance: "low" },
		{ announcement_datetime: 1791981000, release: "inflation", calendar_event_id: "usd_inflation_1791981000", name: "Inflation (CPI)", event_importance: "high", reference_period: "September 2026" },
		{ announcement_datetime: 1791981000, release: "core_inflation", calendar_event_id: "usd_core_inflation_1791981000", name: "Core Inflation", event_importance: "high" },
		{ announcement_datetime: 1791000000, release: "already_out", name: "Already Out", event_importance: "high" }
	]
};

const inflationBody = {
	currency: "USD",
	indicator: "inflation",
	name: "Inflation (CPI)",
	value_metadata: { source_unit: "%YoY", normalization_applied: true },
	freemium_window: { applied: true, max_days: 90 },
	data: [
		{ date: "2026-08-31", val: 3.4, previous_value: 3.3, change_from_previous: 0.1, announcement_datetime: 1789129800 }
	]
};

const NOW = 1791200000 * 1000; // between "already_out" and "trade_balance"

describe("normalizeCurrencies", () => {
	it("uppercases, trims and removes duplicates and junk", () => {
		assert.deepEqual(helpers.normalizeCurrencies([" usd", "EUR", "Usd", "", 5, "toolong", "gb"]), ["USD", "EUR"]);
	});

	it("accepts a single string", () => {
		assert.deepEqual(helpers.normalizeCurrencies("jpy"), ["JPY"]);
	});
});

describe("normalizeIndicators", () => {
	it("keeps valid slugs once", () => {
		assert.deepEqual(helpers.normalizeIndicators(["Inflation", "policy_rate", "inflation", "../x", null]), ["inflation", "policy_rate"]);
	});

	it("returns an empty list for anything that is not an array", () => {
		assert.deepEqual(helpers.normalizeIndicators("inflation"), []);
	});
});

describe("shapeCalendar", () => {
	it("drops past releases and sorts by time, high importance first on ties", () => {
		const releases = helpers.shapeCalendar(calendarBody, { now: NOW });
		assert.deepEqual(releases.map((r) => r.indicator), ["trade_balance", "initial_jobless_claims", "core_inflation", "inflation"]);
		assert.equal(releases[0].time, 1791289800 * 1000);
		assert.equal(releases[0].currency, "USD");
	});

	it("filters by minimum importance", () => {
		const releases = helpers.shapeCalendar(calendarBody, { now: NOW, minImportance: "high" });
		assert.deepEqual(releases.map((r) => r.indicator), ["core_inflation", "inflation"]);
	});

	it("respects the lookahead window", () => {
		const releases = helpers.shapeCalendar(calendarBody, { now: NOW, lookaheadDays: 4 });
		assert.deepEqual(releases.map((r) => r.indicator), ["trade_balance", "initial_jobless_claims"]);
	});

	it("keeps the reference period and falls back to a readable name", () => {
		const body = { currency: "usd", data: [{ announcement_datetime: 1791981000, release: "policy_rate", event_importance: "HIGH", reference_period: "Q3" }] };
		const [release] = helpers.shapeCalendar(body, { now: NOW });
		assert.equal(release.name, "Policy Rate");
		assert.equal(release.importance, "high");
		assert.equal(release.referencePeriod, "Q3");
		assert.equal(release.currency, "USD");
	});

	it("copes with an empty or malformed body", () => {
		assert.deepEqual(helpers.shapeCalendar(null, { now: NOW }), []);
		assert.deepEqual(helpers.shapeCalendar({ data: [{ release: "x" }] }, { now: NOW }), []);
	});
});

describe("mergeReleases", () => {
	it("merges several currencies in time order and trims to maxItems", () => {
		const usd = [{ currency: "USD", name: "B", time: 3, importance: "low" }, { currency: "USD", name: "D", time: 9, importance: "low" }];
		const eur = [{ currency: "EUR", name: "A", time: 1, importance: "high" }, { currency: "EUR", name: "C", time: 3, importance: "high" }];
		const merged = helpers.mergeReleases([usd, eur, null], 3);
		assert.deepEqual(merged.map((r) => r.name), ["A", "C", "B"]);
	});

	it("returns everything when maxItems is 0", () => {
		assert.equal(helpers.mergeReleases([[{ time: 1 }, { time: 2 }]], 0).length, 2);
	});
});

describe("shapeLatest", () => {
	it("picks the newest observation with its unit and change", () => {
		const latest = helpers.shapeLatest(inflationBody, "USD", "inflation");
		assert.deepEqual(latest, {
			currency: "USD",
			indicator: "inflation",
			name: "Inflation (CPI)",
			unit: "%YoY",
			value: 3.4,
			previous: 3.3,
			change: 0.1,
			date: "2026-08-31",
			releasedAt: 1789129800 * 1000,
			outsideFreeWindow: false
		});
	});

	it("flags an empty response inside the free window", () => {
		const latest = helpers.shapeLatest({ name: "GDP", data: [], freemium_window: { applied: true } }, "USD", "gdp");
		assert.equal(latest.value, null);
		assert.equal(latest.outsideFreeWindow, true);
	});

	it("uses a readable name when the API sends none", () => {
		assert.equal(helpers.shapeLatest({ data: [] }, "USD", "policy_rate").name, "Policy Rate");
	});
});

describe("errorKeyForStatus", () => {
	it("maps HTTP status codes to translation keys", () => {
		assert.equal(helpers.errorKeyForStatus(401), "ERROR_KEY_REQUIRED");
		assert.equal(helpers.errorKeyForStatus(403), "ERROR_KEY_REQUIRED");
		assert.equal(helpers.errorKeyForStatus(429), "ERROR_RATE_LIMITED");
		assert.equal(helpers.errorKeyForStatus(404), "ERROR_NOT_FOUND");
		assert.equal(helpers.errorKeyForStatus(500), "ERROR_API");
	});
});

describe("formatValue", () => {
	it("adds a percent sign for percentage units", () => {
		assert.equal(helpers.formatValue(3.4, "%YoY", "en"), "3.4%");
		assert.equal(helpers.formatValue(4, "%", "en"), "4.0%");
	});

	it("shortens large numbers", () => {
		assert.equal(helpers.formatValue(159044000, "Persons", "en"), "159M");
	});

	it("shows plain numbers with up to two decimals", () => {
		assert.equal(helpers.formatValue(52.345, "Index", "en"), "52.35");
	});

	it("shows a dash for missing values", () => {
		assert.equal(helpers.formatValue(null, "%"), "–");
		assert.equal(helpers.formatValue(Number.NaN, "%"), "–");
	});
});

describe("formatCountdown", () => {
	it("formats days, hours and minutes", () => {
		assert.equal(helpers.formatCountdown(((2 * 24 + 4) * 60 + 30) * 60000), "2d 4h");
		assert.equal(helpers.formatCountdown((3 * 60 + 5) * 60000), "3h 05m");
		assert.equal(helpers.formatCountdown(12 * 60000), "12m");
	});

	it("rounds a partial minute up and returns nothing once the time has passed", () => {
		assert.equal(helpers.formatCountdown(1000), "1m");
		assert.equal(helpers.formatCountdown(0), "");
		assert.equal(helpers.formatCountdown(-5000), "");
	});
});

describe("clampInterval", () => {
	it("enforces the minimum and falls back on bad input", () => {
		assert.equal(helpers.clampInterval(1000, 300000, 900000), 300000);
		assert.equal(helpers.clampInterval(1800000, 300000, 900000), 1800000);
		assert.equal(helpers.clampInterval("abc", 300000, 900000), 900000);
		assert.equal(helpers.clampInterval(undefined, 300000, 900000), 900000);
	});
});
