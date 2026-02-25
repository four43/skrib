import { test, expect } from './fixtures.js';

test('Debug fixture - twoUsers works', async ({ twoUsers }) => {
    const { admin, user } = twoUsers;
    console.log('Admin username:', admin.username);
    console.log('User username:', user.username);
    console.log('Admin session token exists:', !!admin.sessionToken);
    console.log('User approval code:', user.approvalCode);
    
    // Try logging in user
    await user.page.goto('/login.html');
    await user.page.locator('#login-button').click();
    await user.page.waitForURL('**/app.html**', { timeout: 15_000 });
    console.log('User logged in successfully');
});
