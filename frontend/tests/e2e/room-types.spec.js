import { test, expect } from './fixtures.js';

/** Generate a unique room name. */
function uniqueRoom(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe('Chat Room Type', () => {
  test('create a chat room and send a message', async ({ registeredUser: { page, username } }) => {
    // Open create-room modal
    await page.locator('#add-channel-btn').click();
    await expect(page.locator('#create-room-modal')).toBeVisible();

    // Wait for room type plugins to load, then select "chat"
    await page.locator('input[name="create-room-type"][value="chat"]').waitFor({ timeout: 10000 });
    await page.locator('input[name="create-room-type"][value="chat"]').check();

    // Enter room name
    const roomName = uniqueRoom('chat');
    await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });

    // Create the room
    await page.locator('#create-room-submit-btn').click();

    // Wait for room to be selected in the header
    await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 10000 });

    // The chat plugin creates #message-input dynamically — wait for it
    await expect(page.locator('#message-input')).toBeVisible({ timeout: 5000 });

    // Send a message
    const messageText = `Hello from chat E2E! ${Date.now()}`;
    await page.locator('#message-input').fill(messageText);
    await page.locator('#send-button').click();

    // Verify message appears in the messages area
    await expect(page.locator('#messages')).toContainText(messageText, { timeout: 5000 });
  });
});

test.describe('Todo Room Type', () => {
  test('create a todo room and add an item', async ({ registeredUser: { page, username } }) => {
    // Open create-room modal
    await page.locator('#add-channel-btn').click();
    await expect(page.locator('#create-room-modal')).toBeVisible();

    // Wait for room type plugins to load, then select "todo"
    await page.locator('input[name="create-room-type"][value="todo"]').waitFor({ timeout: 10000 });
    await page.locator('input[name="create-room-type"][value="todo"]').check();

    // Enter room name
    const roomName = uniqueRoom('todo');
    await page.locator('#new-room-input').pressSequentially(roomName, { delay: 20 });

    // Create the room
    await page.locator('#create-room-submit-btn').click();

    // Wait for room to be selected in the header
    await expect(page.locator('#chat-header-name')).toContainText(roomName, { timeout: 10000 });

    // The todo plugin renders its own UI — wait for the add form
    await expect(page.locator('.todo-add-title')).toBeVisible({ timeout: 5000 });

    // Add a todo item
    const todoTitle = `Test task ${Date.now()}`;
    await page.locator('.todo-add-title').fill(todoTitle);
    await page.locator('.todo-add-btn').click();

    // Verify the item appears in the todo list
    await expect(page.locator('#todo-items-list')).toContainText(todoTitle, { timeout: 5000 });
  });
});
