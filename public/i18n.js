/**
 * Internationalization (i18n) module for Claude Code Runner
 *
 * To add a new language:
 * 1. Create a new JSON file in /public/locales/ (e.g., "fr.json" for French)
 * 2. Copy the structure from en.json and translate all values
 * 3. The language will be automatically available in the language selector
 */

const I18n = (function () {
	const STORAGE_KEY = 'claude-code-runner-lang';
	const DEFAULT_LOCALE = 'en';
	const SUPPORTED_LOCALES = ['en', 'zh-CN'];

	let currentLocale = DEFAULT_LOCALE;
	let translations = {};
	const loadedLocales = {};
	let isInitialized = false;
	let initPromise = null;

	/**
	 * Get cookie value by name
	 */
	function getCookie(name) {
		const value = `; ${document.cookie}`;
		const parts = value.split(`; ${name}=`);
		if (parts.length === 2) {
			return parts.pop().split(';').shift();
		}
		return null;
	}

	/**
	 * Set cookie with expiry
	 */
	function setCookie(name, value, days = 365) {
		const date = new Date();
		date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
		const expires = `expires=${date.toUTCString()}`;
		document.cookie = `${name}=${value};${expires};path=/;SameSite=Lax`;
	}

	/**
	 * Detect user's preferred language from browser settings
	 */
	function detectBrowserLanguage() {
		const browserLangs = navigator.languages || [navigator.language || navigator.userLanguage];

		for (const lang of browserLangs) {
			// Check exact match first
			if (SUPPORTED_LOCALES.includes(lang)) {
				return lang;
			}
			// Check language code without region (e.g., 'zh' from 'zh-TW')
			const baseLang = lang.split('-')[0];
			// Map common variants
			if (baseLang === 'zh') {
				// For Chinese, default to Simplified Chinese
				return 'zh-CN';
			}
			if (SUPPORTED_LOCALES.includes(baseLang)) {
				return baseLang;
			}
		}

		return DEFAULT_LOCALE;
	}

	/**
	 * Load a locale's translations
	 */
	async function loadLocale(locale) {
		if (loadedLocales[locale]) {
			return loadedLocales[locale];
		}

		try {
			const response = await fetch(`/locales/${locale}.json`);
			if (!response.ok) {
				throw new Error(`Failed to load locale: ${locale}`);
			}
			const data = await response.json();
			loadedLocales[locale] = data;
			return data;
		}
		catch (error) {
			console.error(`Error loading locale ${locale}:`, error);
			// Fallback to English if available
			if (locale !== DEFAULT_LOCALE && loadedLocales[DEFAULT_LOCALE]) {
				return loadedLocales[DEFAULT_LOCALE];
			}
			return {};
		}
	}

	/**
	 * Get nested value from object by dot-notation path
	 */
	function getNestedValue(obj, path) {
		return path.split('.').reduce((current, key) => {
			return current && current[key] !== undefined ? current[key] : null;
		}, obj);
	}

	/**
	 * Translate a key
	 * @param {string} key - Dot-notation key (e.g., 'header.connecting')
	 * @param {object} params - Optional parameters for interpolation
	 * @returns {string} Translated string or key if not found
	 */
	function t(key, params = {}) {
		let value = getNestedValue(translations, key);

		if (value === null) {
			console.warn(`Translation missing for key: ${key}`);
			return key;
		}

		// Simple interpolation: replace {{param}} with params.param
		if (typeof value === 'string' && Object.keys(params).length > 0) {
			Object.keys(params).forEach((param) => {
				value = value.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
			});
		}

		return value;
	}

	/**
	 * Update all elements with data-i18n attribute
	 */
	function updateDOM() {
		// Update elements with data-i18n attribute (text content)
		document.querySelectorAll('[data-i18n]').forEach((element) => {
			const key = element.getAttribute('data-i18n');
			const translated = t(key);
			if (translated !== key) {
				element.textContent = translated;
			}
		});

		// Update elements with data-i18n-placeholder attribute
		document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
			const key = element.getAttribute('data-i18n-placeholder');
			const translated = t(key);
			if (translated !== key) {
				element.placeholder = translated;
			}
		});

		// Update elements with data-i18n-title attribute
		document.querySelectorAll('[data-i18n-title]').forEach((element) => {
			const key = element.getAttribute('data-i18n-title');
			const translated = t(key);
			if (translated !== key) {
				element.title = translated;
			}
		});

		// Update document title
		document.title = t('app.title');

		// Update language selector current value
		const langSelector = document.getElementById('language-selector');
		if (langSelector) {
			langSelector.value = currentLocale;
		}
	}

	/**
	 * Set the current locale
	 */
	async function setLocale(locale) {
		if (!SUPPORTED_LOCALES.includes(locale)) {
			console.warn(`Locale ${locale} is not supported, falling back to ${DEFAULT_LOCALE}`);
			locale = DEFAULT_LOCALE;
		}

		translations = await loadLocale(locale);
		currentLocale = locale;
		setCookie(STORAGE_KEY, locale);
		document.documentElement.lang = locale;

		updateDOM();

		// Dispatch event for components that need to react to language changes
		window.dispatchEvent(new CustomEvent('languagechange', { detail: { locale } }));
	}

	/**
	 * Initialize i18n system
	 */
	async function init() {
		if (initPromise) {
			return initPromise;
		}

		initPromise = (async () => {
			// Determine initial locale
			const savedLocale = getCookie(STORAGE_KEY);
			const browserLocale = detectBrowserLanguage();
			const initialLocale = savedLocale || browserLocale;

			// Pre-load default locale as fallback
			await loadLocale(DEFAULT_LOCALE);

			// Load and set the initial locale
			await setLocale(initialLocale);

			isInitialized = true;
		})();

		return initPromise;
	}

	/**
	 * Get current locale
	 */
	function getLocale() {
		return currentLocale;
	}

	/**
	 * Get list of supported locales
	 */
	function getSupportedLocales() {
		return [...SUPPORTED_LOCALES];
	}

	/**
	 * Check if i18n is initialized
	 */
	function ready() {
		return isInitialized;
	}

	// Public API
	return {
		init,
		t,
		setLocale,
		getLocale,
		getSupportedLocales,
		updateDOM,
		ready,
	};
})();
