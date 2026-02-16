# Default Theme

The default dark theme for Mini Chat with light variant support.

## Features

- Clean, modern dark theme
- Light variant available
- Customizable primary color
- Multiple font options
- Responsive design

## Structure

```
com.four43.theme-default/
  manifest.json           # Theme metadata
  css/
    base.css             # Base styles and variables
    components.css       # UI component styles
    rooms.css            # Room list and chat styles
  assets/
    logo.png            # Theme logo
    favicon.ico         # Browser favicon
  README.md
```

## Customization

Users can customize:
- Primary accent color
- Background color
- Font family
- Font size

## Installation

1. Extract to `backend/themes/com.four43.theme-default/`
2. Restart backend server
3. Theme will be available in user preferences

## Development

### CSS Structure

CSS files are loaded in order:
1. `base.css` - CSS variables, resets, base styles
2. `components.css` - Buttons, inputs, modals
3. `rooms.css` - Room-specific layouts

### CSS Variables

All themes should define these variables:
- `--primary-color`
- `--background-color`
- `--text-color`
- `--border-color`
- `--hover-color`

## License

MIT
