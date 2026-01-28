# Internationalization (i18n)

This folder contains the translation files for Claude Code Runner's Web UI.

## Supported Languages

- `en.json` - English (default)
- `zh-CN.json` - Simplified Chinese (简体中文)

## Adding a New Language

To add a new language:

1. **Create a new JSON file** in this folder with the language code as the filename (e.g., `fr.json` for French, `ja.json` for Japanese)

2. **Copy the structure from `en.json`** and translate all values:
   ```bash
   cp en.json <language-code>.json
   ```

3. **Update the `SUPPORTED_LOCALES` array** in `/public/i18n.js`:
   ```javascript
   const SUPPORTED_LOCALES = ['en', 'zh-CN', 'fr']; // Add your new locale
   ```

4. **Add the language option to the selector** in `/public/index.html`:
   ```html
   <select id="language-selector" onchange="I18n.setLocale(this.value)">
     <option value="en">English</option>
     <option value="zh-CN">简体中文</option>
     <option value="fr">Français</option>  <!-- Add your new option -->
   </select>
   ```

5. **Add the language name** to each locale file under `language` key:
   ```json
   "language": {
     "label": "Language",
     "en": "English",
     "zh-CN": "简体中文",
     "fr": "Français"
   }
   ```

## Language File Structure

```json
{
  "app": {
    "title": "Page title",
    "name": "App name"
  },
  "header": { ... },
  "tabs": { ... },
  "terminal": { ... },
  "changes": { ... },
  "status": { ... },
  "messages": { ... },
  "language": { ... }
}
```

## Using Translations in Code

### In HTML (static text)
Use the `data-i18n` attribute:
```html
<span data-i18n="tabs.terminal">Terminal</span>
```

### In JavaScript (dynamic text)
Use the `t()` helper function:
```javascript
const text = t('status.connected', 'Connected');
```

The second parameter is the fallback text if i18n is not ready.

## Language Detection

The system automatically:
1. Checks for a saved language preference in cookies
2. Falls back to browser language preference
3. Defaults to English if no match is found

When users manually select a language, the preference is saved in a cookie for 365 days.
