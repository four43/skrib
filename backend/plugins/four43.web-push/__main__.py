"""Entry point for running web-push plugin as a standalone process."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from skrib_plugin_sdk.loader import load_plugin_class

_mod = load_plugin_class(os.path.dirname(os.path.abspath(__file__)))
WebPushPlugin = _mod.WebPushPlugin


async def main():
    plugin = WebPushPlugin()
    await plugin.run_forever(os.getenv("SKRIB_BUS_URL", "ws://127.0.0.1:9000"))

if __name__ == "__main__":
    asyncio.run(main())
