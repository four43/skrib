#!/usr/bin/env python3
"""
Admin CLI tool - Uses the REST API instead of direct database access.
"""
import sys
import argparse
import requests
from typing import Optional


class AdminCLI:
    """Admin CLI that communicates with the API."""

    def __init__(self, base_url: str = "http://localhost:8000", session_token: Optional[str] = None):
        self.base_url = base_url
        self.session_token = session_token
        self.headers = {}
        if session_token:
            self.headers['Authorization'] = f'Bearer {session_token}'

    def _make_request(self, method: str, endpoint: str, **kwargs):
        """Make an API request."""
        url = f"{self.base_url}{endpoint}"
        kwargs['headers'] = {**self.headers, **kwargs.get('headers', {})}

        try:
            response = requests.request(method, url, **kwargs)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"Error: {e}")
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_detail = e.response.json()
                    print(f"Detail: {error_detail.get('detail', 'Unknown error')}")
                except:
                    pass
            sys.exit(1)

    def list_pending(self):
        """List pending users."""
        data = self._make_request('GET', '/api/users/pending')
        pending = data.get('pending', [])

        if not pending:
            print("No pending users.")
            return

        print(f"\n{'Username':<20} {'Approval Code':<15} {'Registered At':<20}")
        print("-" * 60)
        for user in pending:
            print(f"{user['username']:<20} {user['approval_code']:<15} {user['registered_at']:<20}")

    def list_approved(self):
        """List approved users."""
        data = self._make_request('GET', '/api/users')
        users = data.get('users', [])

        if not users:
            print("No approved users.")
            return

        print(f"\n{'Username':<20} {'Role':<10} {'Approved At':<20} {'Approved By':<20}")
        print("-" * 75)
        for user in users:
            approved_by = user.get('approved_by') or 'N/A'
            approved_at = user.get('approved_at') or 'N/A'
            print(f"{user['username']:<20} {user['role']:<10} {approved_at:<20} {approved_by:<20}")

    def approve(self, code: str):
        """Approve a user by approval code."""
        self._make_request('POST', '/api/users/pending/approve', json={'approval_code': code})
        print(f"Approved user with code: {code}")

    def reject(self, code: str):
        """Reject a user by approval code."""
        self._make_request('POST', '/api/users/pending/reject', json={'approval_code': code})
        print(f"Rejected user with code: {code}")

    def revoke(self, username: str):
        """Revoke user access."""
        self._make_request('DELETE', f'/api/users/{username}')
        print(f"Revoked access for user: {username}")

    def set_admin(self, username: str):
        """Set user as admin."""
        self._make_request('PUT', f'/api/users/{username}/role', json={'role': 'admin'})
        print(f"Set {username} as admin")

    def remove_admin(self, username: str):
        """Remove admin role from user."""
        self._make_request('PUT', f'/api/users/{username}/role', json={'role': 'user'})
        print(f"Removed admin role from {username}")

    def toggle_reg(self):
        """Cycle registration mode."""
        modes = ['closed', 'invite_only', 'approval_required', 'open']
        data = self._make_request('GET', '/api/server')
        current = data.get('registration_mode', 'closed')
        current_idx = modes.index(current) if current in modes else 0
        new_mode = modes[(current_idx + 1) % len(modes)]

        self._make_request('PUT', '/api/server/registration', json={'mode': new_mode})
        print(f"Registration mode: {new_mode}")

    def status(self):
        """Show system status."""
        data = self._make_request('GET', '/api/server')

        print("\n=== System Status ===")
        print(f"Users: {data['users_count']}")
        print(f"Pending: {data['pending_count']}")
        print(f"Rooms: {data['rooms_count']}")
        print(f"Messages: {data['messages_count']}")
        print(f"Registration mode: {data.get('registration_mode', 'unknown')}")


def interactive_mode(cli: AdminCLI):
    """Run interactive mode."""
    print("\n=== Mini Chat Admin CLI ===")
    print("Commands: list, approved, approve <code>, reject <code>,")
    print("          revoke <username>, set-admin <username>, remove-admin <username>,")
    print("          toggle-reg, status, exit")

    while True:
        try:
            command = input("\nadmin> ").strip()
            if not command:
                continue

            parts = command.split()
            cmd = parts[0]

            if cmd == 'exit':
                break
            elif cmd == 'list':
                cli.list_pending()
            elif cmd == 'approved':
                cli.list_approved()
            elif cmd == 'approve' and len(parts) == 2:
                cli.approve(parts[1])
            elif cmd == 'reject' and len(parts) == 2:
                cli.reject(parts[1])
            elif cmd == 'revoke' and len(parts) == 2:
                cli.revoke(parts[1])
            elif cmd == 'set-admin' and len(parts) == 2:
                cli.set_admin(parts[1])
            elif cmd == 'remove-admin' and len(parts) == 2:
                cli.remove_admin(parts[1])
            elif cmd == 'toggle-reg':
                cli.toggle_reg()
            elif cmd == 'status':
                cli.status()
            else:
                print("Invalid command or missing arguments")

        except KeyboardInterrupt:
            print("\nExiting...")
            break
        except Exception as e:
            print(f"Error: {e}")


def main():
    parser = argparse.ArgumentParser(description='Mini Chat Admin CLI')
    parser.add_argument('--url', default='http://localhost:8000', help='API base URL')
    parser.add_argument('--token', help='Session token (if you have one)')

    subparsers = parser.add_subparsers(dest='command', help='Command to execute')

    subparsers.add_parser('list', help='List pending users')
    subparsers.add_parser('approved', help='List approved users')

    approve_parser = subparsers.add_parser('approve', help='Approve a user')
    approve_parser.add_argument('code', help='Approval code')

    reject_parser = subparsers.add_parser('reject', help='Reject a user')
    reject_parser.add_argument('code', help='Approval code')

    revoke_parser = subparsers.add_parser('revoke', help='Revoke user access')
    revoke_parser.add_argument('username', help='Username')

    set_admin_parser = subparsers.add_parser('set-admin', help='Set user as admin')
    set_admin_parser.add_argument('username', help='Username')

    remove_admin_parser = subparsers.add_parser('remove-admin', help='Remove admin role')
    remove_admin_parser.add_argument('username', help='Username')

    subparsers.add_parser('toggle-reg', help='Toggle registration')
    subparsers.add_parser('status', help='Show system status')

    args = parser.parse_args()

    cli = AdminCLI(base_url=args.url, session_token=args.token)

    if args.command:
        # Direct command mode
        if args.command == 'list':
            cli.list_pending()
        elif args.command == 'approved':
            cli.list_approved()
        elif args.command == 'approve':
            cli.approve(args.code)
        elif args.command == 'reject':
            cli.reject(args.code)
        elif args.command == 'revoke':
            cli.revoke(args.username)
        elif args.command == 'set-admin':
            cli.set_admin(args.username)
        elif args.command == 'remove-admin':
            cli.remove_admin(args.username)
        elif args.command == 'toggle-reg':
            cli.toggle_reg()
        elif args.command == 'status':
            cli.status()
    else:
        # Interactive mode
        interactive_mode(cli)


if __name__ == '__main__':
    main()
