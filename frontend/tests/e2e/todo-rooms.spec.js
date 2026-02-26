/**
 * E2E tests: Todo room type plugin — task CRUD, checkbox toggling,
 * filters, permissions, real-time sync, persistence.
 *
 * Uses the `threeUsers` fixture (admin User A, User B, User C).
 */

import { test, expect } from './fixtures.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a todo-type room via the UI. */
async function createTodoRoom(page, roomName) {
    await page.locator('#add-channel-btn').click();
    await page.locator('#new-room-input').fill(roomName);

    // Select "todo" room type radio button
    await page.locator('input[name="create-room-type"][value="todo"]').check();

    await page.locator('#create-room-submit-btn').click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);

    // Wait for the todo UI to render
    await page.locator('.todo-container').waitFor();
}

async function sendCommand(page, command) {
    await page.locator('#message-input').fill(command);
    await page.locator('#message-input').press('Enter');
}

async function inviteUser(page, username) {
    await sendCommand(page, `/invite ${username}`);
    // Todo rooms don't have a #messages area with system messages the same way,
    // but the invite command runs at the core level. Wait briefly for the invite to process.
    await page.waitForTimeout(500);
}

async function navigateToRoom(page, roomName) {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`.room-item[data-room-id="${roomName}"]`).waitFor();
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

async function selectRoom(page, roomName) {
    await page.locator(`.room-item[data-room-id="${roomName}"]`).click();
    await expect(page.locator('#room-content-name')).toHaveText(`#${roomName}`);
}

/** Add a todo item via the add form. */
async function addTodoItem(page, title, description = '') {
    await page.locator('.todo-add-title').fill(title);
    if (description) {
        await page.locator('.todo-add-desc').fill(description);
    }
    await page.locator('.todo-add-btn').click();
    await expect(page.locator('.todo-item', { hasText: title })).toBeVisible();
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Todo room UI and task creation', () => {

    test('Todo room shows correct UI elements and supports adding tasks', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-room');

        // Verify filter buttons
        await expect(userA.page.locator('.todo-filter-btn', { hasText: 'All' })).toBeVisible();
        await expect(userA.page.locator('.todo-filter-btn', { hasText: 'Active' })).toBeVisible();
        await expect(userA.page.locator('.todo-filter-btn', { hasText: 'Done' })).toBeVisible();

        // Verify counter shows zeros
        await expect(userA.page.locator('.todo-count')).toContainText('0 active');

        // Verify empty state
        await expect(userA.page.locator('.todo-empty')).toBeVisible();

        // Add a task
        await addTodoItem(userA.page, 'Buy groceries');

        // Counter updates
        await expect(userA.page.locator('.todo-count')).toContainText('1 active');

        // Add another with description
        await addTodoItem(userA.page, 'Walk the dog', 'Take the long route');
        await expect(userA.page.locator('.todo-count')).toContainText('2 active');

        // Description is visible
        await expect(userA.page.locator('.todo-item', { hasText: 'Walk the dog' }).locator('.todo-item-desc')).toContainText('Take the long route');
    });

    test('Empty title is not added', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-empty-title');

        // Try to add with empty title
        await userA.page.locator('.todo-add-btn').click();

        // No items should be created
        await expect(userA.page.locator('.todo-item')).toHaveCount(0);
    });
});

test.describe('Todo collaboration and real-time sync', () => {

    test('User B sees tasks, both users can add, checkbox syncs in real-time', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-collab');

        // User A adds two tasks
        await addTodoItem(userA.page, 'Buy groceries');
        await addTodoItem(userA.page, 'Walk the dog', 'Take the long route');

        // Invite User B via API (slash commands are for chat rooms)
        const resp = await userA.page.request.post(
            `${userA.page.url().split('/app.html')[0]}/api/rooms/todo-collab/members`,
            {
                headers: { 'Authorization': `Bearer ${userA.sessionToken}`, 'Content-Type': 'application/json' },
                data: { username: userB.username },
            }
        );
        expect(resp.ok()).toBeTruthy();

        // User B opens the room and sees both tasks
        await navigateToRoom(userB.page, 'todo-collab');
        await userB.page.locator('.todo-container').waitFor();
        await expect(userB.page.locator('.todo-item')).toHaveCount(2);
        await expect(userB.page.locator('#messages')).toContainText('Buy groceries');
        await expect(userB.page.locator('#messages')).toContainText('Walk the dog');

        // User B adds a task — appears for both
        await addTodoItem(userB.page, 'Reply to emails');
        await expect(userA.page.locator('.todo-item', { hasText: 'Reply to emails' })).toBeVisible();

        // User B toggles checkbox on "Buy groceries"
        const itemB = userB.page.locator('.todo-item', { hasText: 'Buy groceries' });
        await itemB.locator('.todo-checkbox').check();

        // Both users see it as done
        await expect(itemB).toHaveClass(/done/);
        await expect(userA.page.locator('.todo-item', { hasText: 'Buy groceries' })).toHaveClass(/done/);

        // Counter updates for both
        await expect(userA.page.locator('.todo-count')).toContainText('2 active');
        await expect(userA.page.locator('.todo-count')).toContainText('1 done');
    });
});

test.describe('Todo filters', () => {

    test('Filter buttons show correct items', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-filters');
        await addTodoItem(userA.page, 'Active task');
        await addTodoItem(userA.page, 'Done task');

        // Mark "Done task" as done
        const doneItem = userA.page.locator('.todo-item', { hasText: 'Done task' });
        await doneItem.locator('.todo-checkbox').check();
        await expect(doneItem).toHaveClass(/done/);

        // "All" filter shows both
        await userA.page.locator('.todo-filter-btn', { hasText: 'All' }).click();
        await expect(userA.page.locator('.todo-item')).toHaveCount(2);

        // "Active" filter shows only "Active task"
        await userA.page.locator('.todo-filter-btn', { hasText: 'Active' }).click();
        await expect(userA.page.locator('.todo-item:visible')).toHaveCount(1);
        await expect(userA.page.locator('.todo-item:visible')).toContainText('Active task');

        // "Done" filter shows only "Done task"
        await userA.page.locator('.todo-filter-btn', { hasText: 'Done' }).click();
        await expect(userA.page.locator('.todo-item:visible')).toHaveCount(1);
        await expect(userA.page.locator('.todo-item:visible')).toContainText('Done task');

        // Uncheck "Done task" — it returns to active
        await userA.page.locator('.todo-filter-btn', { hasText: 'All' }).click();
        const item = userA.page.locator('.todo-item', { hasText: 'Done task' });
        await item.locator('.todo-checkbox').uncheck();
        await expect(item).not.toHaveClass(/done/);
    });
});

test.describe('Todo editing', () => {

    test('Creator can edit, non-creator cannot edit but can toggle checkbox', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-edit');
        await addTodoItem(userA.page, 'Edit me');

        // Invite User B via API
        const resp = await userA.page.request.post(
            `${userA.page.url().split('/app.html')[0]}/api/rooms/todo-edit/members`,
            {
                headers: { 'Authorization': `Bearer ${userA.sessionToken}`, 'Content-Type': 'application/json' },
                data: { username: userB.username },
            }
        );
        expect(resp.ok()).toBeTruthy();
        await navigateToRoom(userB.page, 'todo-edit');
        await userB.page.locator('.todo-container').waitFor();

        // User A (creator) sees Edit button and can use it
        const itemA = userA.page.locator('.todo-item', { hasText: 'Edit me' });
        await expect(itemA.locator('.todo-edit-btn')).toBeVisible();
        await itemA.locator('.todo-edit-btn').click();

        // Edit form appears
        const editTitle = itemA.locator('.todo-edit-title');
        await expect(editTitle).toBeVisible();
        await editTitle.fill('Edited title');
        await itemA.locator('.todo-save-btn').click();

        // Title updated for both users
        await expect(userA.page.locator('.todo-item', { hasText: 'Edited title' })).toBeVisible();
        await expect(userB.page.locator('.todo-item', { hasText: 'Edited title' })).toBeVisible();

        // User B (non-creator) should NOT see Edit button on User A's task
        const itemB = userB.page.locator('.todo-item', { hasText: 'Edited title' });
        await expect(itemB.locator('.todo-edit-btn')).toHaveCount(0);

        // User B CAN toggle the checkbox
        await itemB.locator('.todo-checkbox').check();
        await expect(itemB).toHaveClass(/done/);
        await expect(userA.page.locator('.todo-item', { hasText: 'Edited title' })).toHaveClass(/done/);

        // User B adds their own task — they can edit it
        await addTodoItem(userB.page, 'User B task');
        const itemBOwn = userB.page.locator('.todo-item', { hasText: 'User B task' });
        await expect(itemBOwn.locator('.todo-edit-btn')).toBeVisible();
    });
});

test.describe('Todo deletion', () => {

    test('Creator can delete, non-creator cannot delete', async ({ threeUsers }) => {
        const { admin: userA, userB } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-delete');
        await addTodoItem(userA.page, 'Delete me');
        await addTodoItem(userA.page, 'Keep me');

        // Invite User B via API
        const resp = await userA.page.request.post(
            `${userA.page.url().split('/app.html')[0]}/api/rooms/todo-delete/members`,
            {
                headers: { 'Authorization': `Bearer ${userA.sessionToken}`, 'Content-Type': 'application/json' },
                data: { username: userB.username },
            }
        );
        expect(resp.ok()).toBeTruthy();
        await navigateToRoom(userB.page, 'todo-delete');
        await userB.page.locator('.todo-container').waitFor();

        // User B should NOT see Delete button on User A's tasks
        const itemB = userB.page.locator('.todo-item', { hasText: 'Delete me' });
        await expect(itemB.locator('.todo-delete-btn')).toHaveCount(0);

        // User A (creator) deletes "Delete me" — accept confirm dialog
        userA.page.once('dialog', dialog => dialog.accept());
        const itemA = userA.page.locator('.todo-item', { hasText: 'Delete me' });
        await itemA.locator('.todo-delete-btn').click();

        // Task disappears for both users
        await expect(userA.page.locator('.todo-item', { hasText: 'Delete me' })).toHaveCount(0);
        await expect(userB.page.locator('.todo-item', { hasText: 'Delete me' })).toHaveCount(0);

        // "Keep me" still exists
        await expect(userA.page.locator('.todo-item', { hasText: 'Keep me' })).toBeVisible();
    });
});

test.describe('Todo persistence', () => {

    test('Tasks persist after page reload', async ({ threeUsers }) => {
        const { admin: userA } = threeUsers;
        await userA.page.waitForLoadState('networkidle');

        await createTodoRoom(userA.page, 'todo-persist');
        await addTodoItem(userA.page, 'Persistent task');
        await addTodoItem(userA.page, 'Another task');

        // Mark one as done
        const item = userA.page.locator('.todo-item', { hasText: 'Persistent task' });
        await item.locator('.todo-checkbox').check();

        // Refresh
        await userA.page.reload();
        await userA.page.waitForLoadState('networkidle');
        await selectRoom(userA.page, 'todo-persist');
        await userA.page.locator('.todo-container').waitFor();

        // Both tasks still present
        await expect(userA.page.locator('.todo-item')).toHaveCount(2);
        await expect(userA.page.locator('.todo-item', { hasText: 'Persistent task' })).toHaveClass(/done/);
        await expect(userA.page.locator('.todo-item', { hasText: 'Another task' })).not.toHaveClass(/done/);
    });
});
