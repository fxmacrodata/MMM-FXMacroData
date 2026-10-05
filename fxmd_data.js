/*
 * Pure helpers shared by the browser module and the node helper.
 *
 * Nothing in here touches the network or the DOM, so it can be loaded with
 * require() in Node (node_helper.js and the tests) and as a plain script in
 * the browser (via getScripts in MMM-FXMacroData.js).
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.FXMacroDataHelpers = factory();
	}
}(typeof globalThis === "undefined" ? this : globalThis, function () {
	const IMPORTANCE_RANK = { low: 1, medium: 2, high: 3 };

	/**
	 * Uppercase, de-duplicate and validate a list of currency codes.
	 * @param {string[]|string} list Codes from the user config.
	 * @returns {string[]} Clean three-letter codes, in the order given.
	 */
	function normalizeCurrencies (list) {
		const input = Array.isArray(list) ? list : [list];
		const seen = new Set();
		const out = [];
		for (const entry of input) {
			if (typeof entry !== "string") continue;
			const code = entry.trim().toUpperCase();
			if (!(/^[A-Z]{3,4}$/u).test(code) || seen.has(code)) continue;
			seen.add(code);
			out.push(code);
		}
		return out;
	}

	/**
	 * Lowercase and de-duplicate indicator slugs such as "policy_rate".
	 * @param {string[]} list Slugs from the user config.
	 * @returns {string[]} Clean slugs.
	 */
	function normalizeIndicators (list) {
		if (!Array.isArray(list)) return [];
		const seen = new Set();
		const out = [];
		for (const entry of list) {
			if (typeof entry !== "string") continue;
			const slug = entry.trim().toLowerCase();
			if (!(/^[a-z0-9_]+$/u).test(slug) || seen.has(slug)) continue;
			seen.add(slug);
			out.push(slug);
		}
		return out;
	}

	/**
	 * Rank an importance label so it can be compared ("high" > "medium" > "low").
	 * Unknown or missing labels rank as "low".
	 * @param {string} importance Label from the API.
	 * @returns {number} 1, 2 or 3.
	 */
	function importanceRank (importance) {
		return IMPORTANCE_RANK[String(importance || "").toLowerCase()] || 1;
	}

	/**
	 * Turn one calendar response into a sorted list of upcoming releases.
	 * @param {object} body Parsed JSON from /v1/calendar/{currency}.
	 * @param {object} options Filter options.
	 * @param {number} options.now Current time in milliseconds.
	 * @param {string} [options.minImportance] Drop releases below this level.
	 * @param {number} [options.lookaheadDays] Ignore releases further out than this.
	 * @returns {object[]} Releases with times in milliseconds, earliest first.
	 */
	function shapeCalendar (body, options) {
		const now = options.now;
		const minRank = importanceRank(options.minImportance || "low");
		const horizon = options.lookaheadDays > 0 ? now + (options.lookaheadDays * 86400000) : Infinity;
		const rows = body && Array.isArray(body.data) ? body.data : [];
		const currency = body && typeof body.currency === "string" ? body.currency.toUpperCase() : "";

		const releases = [];
		for (const row of rows) {
			if (!row || typeof row.announcement_datetime !== "number") continue;
			const time = row.announcement_datetime * 1000;
			if (time <= now || time > horizon) continue;
			const importance = String(row.event_importance || "low").toLowerCase();
			if (importanceRank(importance) < minRank) continue;
			releases.push({
				id: row.calendar_event_id || `${currency}_${row.release}_${row.announcement_datetime}`,
				currency,
				indicator: row.release,
				name: row.name || prettifySlug(row.release),
				time,
				importance: IMPORTANCE_RANK[importance] ? importance : "low",
				referencePeriod: row.reference_period || null
			});
		}
		releases.sort(compareReleases);
		return releases;
	}

	/**
	 * Order releases by time, then by importance (high first), then by name.
	 * @param {object} a First release.
	 * @param {object} b Second release.
	 * @returns {number} Sort order.
	 */
	function compareReleases (a, b) {
		return (a.time - b.time)
			|| (importanceRank(b.importance) - importanceRank(a.importance))
			|| String(a.currency + a.name).localeCompare(String(b.currency + b.name));
	}

	/**
	 * Merge per-currency release lists into one list and keep the first N.
	 * @param {object[][]} lists One list per currency.
	 * @param {number} maxItems Maximum number of releases to keep.
	 * @returns {object[]} Merged releases, earliest first.
	 */
	function mergeReleases (lists, maxItems) {
		const merged = [].concat(...lists.filter(Array.isArray));
		merged.sort(compareReleases);
		return maxItems > 0 ? merged.slice(0, maxItems) : merged;
	}

	/**
	 * Pick the latest observation out of an announcements response.
	 * @param {object} body Parsed JSON from /v1/announcements/{currency}/{indicator}.
	 * @param {string} currency Currency the request was made for.
	 * @param {string} indicator Indicator the request was made for.
	 * @returns {object} The latest value, or a row with value null when there is none.
	 */
	function shapeLatest (body, currency, indicator) {
		const rows = body && Array.isArray(body.data) ? body.data : [];
		const latest = rows[0] || null;
		const unit = body && body.value_metadata && typeof body.value_metadata.source_unit === "string"
			? body.value_metadata.source_unit
			: null;
		const name = body && typeof body.name === "string" && body.name ? body.name : prettifySlug(indicator);
		const outsideFreeWindow = !latest && Boolean(body && body.freemium_window && body.freemium_window.applied);

		return {
			currency,
			indicator,
			name,
			unit,
			value: latest && typeof latest.val === "number" ? latest.val : null,
			previous: latest && typeof latest.previous_value === "number" ? latest.previous_value : null,
			change: latest && typeof latest.change_from_previous === "number" ? latest.change_from_previous : null,
			date: latest ? latest.date || null : null,
			releasedAt: latest && typeof latest.announcement_datetime === "number" ? latest.announcement_datetime * 1000 : null,
			outsideFreeWindow
		};
	}

	/**
	 * Map an HTTP failure to a translation key the module can show.
	 * @param {number} status HTTP status code.
	 * @returns {string} Translation key.
	 */
	function errorKeyForStatus (status) {
		if (status === 401 || status === 403) return "ERROR_KEY_REQUIRED";
		if (status === 429) return "ERROR_RATE_LIMITED";
		if (status === 404) return "ERROR_NOT_FOUND";
		return "ERROR_API";
	}

	/**
	 * Turn "policy_rate" into "Policy Rate" for when the API sends no name.
	 * @param {string} slug Indicator slug.
	 * @returns {string} Readable label.
	 */
	function prettifySlug (slug) {
		return String(slug || "")
			.split("_")
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	/**
	 * Format a value with its unit, keeping big numbers short.
	 * @param {number|null} value The number to format.
	 * @param {string|null} unit Unit reported by the API, e.g. "%" or "%YoY".
	 * @param {string} [locale] BCP 47 locale for number formatting.
	 * @returns {string} Display text, or an en dash when there is no value.
	 */
	function formatValue (value, unit, locale) {
		if (typeof value !== "number" || !Number.isFinite(value)) return "–";
		const isPercent = typeof unit === "string" && unit.trim().startsWith("%");
		if (isPercent) {
			return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value)}%`;
		}
		if (Math.abs(value) >= 100000) {
			return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
		}
		return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
	}

	/**
	 * Short countdown text such as "2d 4h", "3h 05m" or "12m".
	 * @param {number} ms Milliseconds until the release.
	 * @returns {string} Countdown text, or an empty string once it has passed.
	 */
	function formatCountdown (ms) {
		if (!(ms > 0)) return "";
		const totalMinutes = Math.ceil(ms / 60000);
		const days = Math.floor(totalMinutes / 1440);
		const hours = Math.floor((totalMinutes % 1440) / 60);
		const minutes = totalMinutes % 60;
		if (days > 0) return `${days}d ${hours}h`;
		if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
		return `${minutes}m`;
	}

	/**
	 * Clamp the refresh interval so a misconfigured mirror cannot hammer the API.
	 * @param {number} value Interval in milliseconds from the config.
	 * @param {number} minimum Smallest interval allowed.
	 * @param {number} fallback Interval to use when the value is not a number.
	 * @returns {number} Interval in milliseconds.
	 */
	function clampInterval (value, minimum, fallback) {
		const number = Number(value);
		if (!Number.isFinite(number) || number <= 0) return fallback;
		return Math.max(number, minimum);
	}

	return {
		normalizeCurrencies,
		normalizeIndicators,
		importanceRank,
		shapeCalendar,
		mergeReleases,
		shapeLatest,
		errorKeyForStatus,
		prettifySlug,
		formatValue,
		formatCountdown,
		clampInterval
	};
}));
