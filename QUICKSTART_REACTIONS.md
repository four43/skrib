# Quick Start: Test Message Reactions Plugin

## 🚀 Start the Application

### Terminal 1 - Backend
```bash
cd backend
uvicorn mini_chat.main:app --reload --host 0.0.0.0 --port 8000
```

**Look for these log messages:**
```
[Plugins] Found distributed plugin with backend: com.four43.message-reactions
[Plugins] Registered plugin: message-reactions v1.0.0
[Plugins] Registered routes for: message-reactions
[Plugins] Registered WebSocket namespace for: message-reactions
[Reactions Plugin] Database initialized
```

### Terminal 2 - Frontend
```bash
cd frontend
npm run dev
```

## ✨ Test the Plugin (2 minutes)

1. **Open browser** → http://localhost:5173
2. **Login** with WebAuthn (create account if needed)
3. **Create/join a room**
4. **Send a test message** (e.g., "Testing reactions!")
5. **Click the `+` button** below your message
6. **Pick an emoji** (e.g., 👍)
7. **See the reaction appear** with count "1"

### Test Real-Time Sync

8. **Open another browser/incognito tab**
9. **Login as a different user**
10. **Join the same room**
11. **Click the same emoji** on the same message
12. **Watch both tabs update** to show count "2"
13. **Hover over the reaction** to see both usernames

### Test Remove

14. **Click the reaction again** (on either tab)
15. **Watch it decrement** to "1"
16. **Both users see the update** in real-time

## 🎯 What to Look For

### ✅ Frontend
- [ ] `+` button appears below messages
- [ ] Emoji picker shows 8 emoji options
- [ ] Clicking emoji adds reaction immediately
- [ ] Reaction shows emoji + count
- [ ] Your reactions have blue background
- [ ] Clicking reaction toggles it on/off
- [ ] Hover shows list of usernames

### ✅ Backend Console
- [ ] Plugin loads on startup
- [ ] Database table created
- [ ] Routes registered at `/api/reactions/*`
- [ ] WebSocket namespace `reactions` registered
- [ ] Logs show `[Reactions] user added emoji to message X`

### ✅ Network Tab
- [ ] WebSocket sends `reactions.add` messages
- [ ] WebSocket receives `reactions.added` broadcasts
- [ ] REST API loads reactions: `GET /api/reactions/message/{id}`

## 🔍 Database Inspection

```bash
# Open the database
sqlite3 backend/chat.db

# View the schema
.schema message_reactions

# See all reactions
SELECT * FROM message_reactions;

# Count reactions per message
SELECT message_id, emoji, COUNT(*) as count
FROM message_reactions
GROUP BY message_id, emoji;

# Exit
.quit
```

## 🐛 If Something's Wrong

### Plugin Not Loading
```bash
# Check plugin exists
ls -la backend/plugins/com.four43.message-reactions/backend/plugin.py

# Check for Python errors
cd backend/plugins/com.four43.message-reactions/backend
python3 -c "import plugin"
```

### No `+` Button on Messages
```javascript
// Open browser console (F12)
// Check if messages have IDs
document.querySelectorAll('.message').forEach(m => {
    console.log('Message ID:', m.dataset.messageId);
});

// Should output: Message ID: 1, Message ID: 2, etc.
```

### Reactions Not Syncing
```javascript
// Check WebSocket is connected
// In browser console, should see:
// [WS] Connected

// Send a test message
// Should see: [WS] Sent reactions.add
// Should see: [WS] Received reactions.added
```

### Database Table Missing
```bash
# Check if table exists
sqlite3 backend/chat.db "SELECT name FROM sqlite_master WHERE type='table' AND name='message_reactions';"

# If empty, table wasn't created
# Restart backend and check logs
```

## 🎨 Customize It

### Change Available Emojis
Edit: `backend/plugins/com.four43.message-reactions/frontend/plugin.js`
```javascript
const COMMON_EMOJIS = ['🔥', '💯', '✨', '💪', '🎯', '🚀', '⭐', '💎'];
```

### Change Reaction Button Style
Edit: `backend/plugins/com.four43.message-reactions/frontend/plugin.css`
```css
.com-four43-reaction-btn {
    border-radius: 20px;  /* More rounded */
    padding: 5px 12px;    /* Larger */
    font-size: 16px;      /* Bigger emoji */
}
```

### Limit Reactions Per User
Edit: `backend/plugins/com.four43.message-reactions/backend/database.py`

In `add_reaction()` function, before the INSERT:
```python
# Check existing reaction count
cursor = conn.execute('''
    SELECT COUNT(*) as count FROM message_reactions
    WHERE message_id = ? AND username = ?
''', (message_id, username))

if cursor.fetchone()['count'] >= 3:  # Max 3 different emojis per message
    return False
```

## ✅ Success!

If you can:
- ✓ See reactions on messages
- ✓ Add/remove reactions with mouse clicks
- ✓ See real-time updates across multiple users
- ✓ Reactions persist after page reload

**Your plugin is working perfectly! 🎉**

## 📚 Next Steps

1. Read [`REACTIONS_PLUGIN_IMPLEMENTATION.md`](REACTIONS_PLUGIN_IMPLEMENTATION.md) for full details
2. Read [`backend/plugins/com.four43.message-reactions/README.md`](backend/plugins/com.four43.message-reactions/README.md) for API docs
3. Use this as a template for other plugins (bookmarks, threads, polls, etc.)

---

**Have fun with reactions! 😂❤️👍🎉**
