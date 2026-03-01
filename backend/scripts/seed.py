#!/usr/bin/env python3
"""Seed the Skrib database with test data for development.

Inserts the admin user (seth) from a saved row, creates fake users,
chat rooms, and messages so you have realistic data to browse in the UI.

Usage:
    cd backend && python -m scripts.seed

Requires the server to be running (rooms and messages are created via HTTP API
because the chat plugin has its own separate database).
"""
import base64
import json
import sys
import os

import requests
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Ensure the backend package is importable when run as `python -m scripts.seed`
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from skrib.database import init_db, get_db, get_setting, set_setting
from skrib.auth.services import create_pending_user, create_session_token

# ---------------------------------------------------------------------------
# Admin user row (exported from a live DB — credential_id and public_key
# match the passkey on Seth's device so browser login works after a reset)
# ---------------------------------------------------------------------------

ADMIN_USER = {
    "username": "seth",
    "credential_id": "iig66StrTzqUEe2i8xty-Q",
    "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEG_jHQ0MGLJ3_H9H1odBva4OCLav-3SPltuZff2pg1R--tk8HqmplyH9-S2nwx-3L7tiFRsTgpCgn-_L4K0SIYA",
    "status": "active",
    "role": "admin",
    "approval_code": None,
    "encryption_public_key": '{"alg":"RSA-OAEP-256","e":"AQAB","ext":true,"key_ops":["encrypt"],"kty":"RSA","n":"tE7n8D5GLA7w4bGDDuRwTv5LZSe4K8zmnSkFXKptvRtif5QlFZTXs6hGtjIR8_J4u6kjhpv96nUzb1jCxxrQgN5dg6UL0p2D1eElNnSy7iicibjMDs8cgz4dk7QDnjp2bioN0xAfnm1S0C6u0GZJ9Rhrbh1zXNz83qJsq6eVnnIuq11CdM16BseikGzhlFfEubWTVaVOqWZb7eeK87VJQlZJXeO39AuXVPOUM0XgtXGityj9AXabZ61bdY1Ug8WYuIts-I3Qbo8upRQosn4FxO_A6wVXPtRnEfjS0Ma4DC_UF9K13JQnuRYiT-VQo-RUyZ4Nac1D7Y6r3rZLDLCB9Q"}',
    "color": "#1f77b4",
    "nickname": None,
    "created_at": "2026-02-25T10:37:13.891663",
    "approved_at": "2026-02-25T10:37:13.891663",
    "approved_by": "system",
    "theme_name": None,
    "color_scheme": None,
    "encrypted_private_key": None,
    "passphrase_encrypted_private_key": '{"v":1,"salt":"oeZuV_w2-ntJhkc17JQa-g","iv":"eX3kKGQvmqAOoP7d","ct":"PTaszEKKCWZCiYkBbeWjR-UHGCEIj3T_-gL61wxmCG7Uy_ZuLrR025Up2bwNSYIVkHN9cYw5-EkWNoy5xs0QEZt6p2mnvGdJVJHXUZjhHSrD1IYWGuOyxsvsORyoQ2rcucVRL5KyjvbPXJWIIat46CgBx6p8tvmfbleCpMjxzQMsg96_GRpVFUjC-1j_J39Oo3C6PABiTqG-7gZWFoK5-_DNTNbrAXK5ZV3WEFjWtE-xdsZ_-XwGwtnbrZuZtC9sCUXYXtHcpl32EnTqkM7eEln9QXYPmbOkvL4EdvmsWqQECN-BuYJhjbJxuV44d6hSDznhWV5HI7QKtgDDr8FQH5xoLYraRlNapFV14o__I9tzcI9Be02xETV7MJ4pSXd7A9lkeE9uHQbM9KOozQQHBwEcZfIOxDND_eghdi_yhSxocbhji8OVaZNRyQFnwOfOcTCIkNW1H8jdtrNslgkmHc5JO4oFeolzK8PpHQAsLSH2dTtyeUjZsdB4rSnnbXYL3sBEI_uGLj6jKnkaPkjDfLbDKvYCnOoY0_u79kHG7lGnhtiVxNwYzRNvWOMdtFVWoNVhnUOs5WYoXHVw-5_TqhgebMWBaqI5t83FJ78GP6i0SDwvcufywxxZs2z_YjIhsWW_Fc7iu83Ru7FEuNEFrXOetYPrjEuE38zlbAxnhNngLBv8O-hsbPSFJrozrH6samKGFBmLPItLDgmmMSpF5SA6k7xEEDKlWirWZM0TqwZdjAtCxYmx0BnPxq-2bRymzS1dB5Q_kqMMZ1OLXWENI62j1EvLNVOXTPO6661a_WqUpzTGX-lOedCvplvxETBm4ATe26Uq-PVpzVJ4dyI_iqEZKwV41-3nsClT2B2kUW0IM-wRu7lAlQ_qHWuNNLQ-IToYgoWVf3AGCeoCP8KMFRs5GMRKa1WUbypP3djqIPzeJDeUZ01FG-A47_SxmI-ovCnTHI0JLwjbwlK0jaIs4k_AP53xenbReXNJ4-7ObnZhFges8_MQwVW5mbTKk-Khju83JO_UdvmMTwvTOizkqnCyKKof43vl9H0Cp86kSzgmI0tr43PakLS0RSKG5qd__Kt4YHzv2QlAOA_03mT4F1ilfVEuZyBVXhzGQtA92BuqRmlAof7HHhlYbCPnVIRVOfbaZT_FtsnmIkKmmec3UBPrgkySJypmXFPF4JTydASrXruhW25RjNaHDAtZJPXOWScurnw7yJFx8a76uyEjSwaVfxEkmiaoluKnxMl-gDQJg0jt_Yw05VxFty0KdgUXW4zNftVJMAfjTTA_r6CidjP0uQBcBqFZw1of9y--k3R4oU8iv5sup-2qtOZXAtUP3MJx-C5G4f-2Gzdh-QfzrEOGWeX4ws9spEM-xZRvARK7b6PPHgJKeR1SRzfhwvuuJVXtRvgd2WbdRRtbwY6LaOkKjt5tlg10SiXj7l3MXa9FCLIlJLQa2padmJ3XGofCVcp9uq3iplsdVwkt1yXAB-0ljVIdqHt2zIduxncanVtbJBBen3QyInkyJYLNlspkZD6YR7-ZmPafRzWRi0Fbtn2jKZOlTBle0GEURzcscZFPycxGwSBvJHnCemzzCPqKjOc7sjhS3_n-Et68cCMU7e2th2FHo_OMRMfWFK0RO_UO5PpgPOssEKt_LAgdxSeJXRJ2nm0JJIg_hw-fZwd1lE52BYQ0wTjv5pIrt7RxlvMdQKJ4u4WaMMPp9Yy6emm6XkyMyMccNy4Ah7pJTW4ECkpuLyuCkfq2TMuI94WifTD8kKWrBxof4GQVmphI73fHqi4fDGpHBI_s4cIg_PKp6cJstKKjIRqN56EORAgQ9AM6HEiEXEDeQGKYbhJ16Rwb_OxpqTvS0yTBYEdkfOGE_9YxlZkhJouYy9jdh63AOmGG7mmGr6Q--umwqHprGSXiy2gOPDflAcyt_cTAFTznqrxRbDZda7CvuKMI7P5tmkCQctWFsqNf822RzJfybLukM0eQkJk5gOMuz0yCfqMl-3NTiBvIxBP0ale8S4D3xmSnoQOKwpb-14TXrTyiyPSPFFjxW7jcueA4wPpaV1kVUcth0naq5Y6BZ-ovrazaV0YXAy1Kiz7a7EvwK0EzNXggjHMAQXtYo6imeOUW1gjdTTFM6sws-EOwWb0T4G3zkXfLoDKC3kfTVe5pXDp9rQFEIZQJy7V4PJFcgh6kZVoiKNh-POb9pTgP34wJgfBJJNAUK-_GjsyZMam2w0dXj_hxoAq90Ck","iterations":600000}',
    "avatar_data_b64": "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABpklEQVR4nO3dsUkEQRiA0Tm52MBUcyMrMLMbwQIswQIEuzGzAiPzM71AMDOwg3PZwXuC34t3mB0+/mgZdrPbf444J/oF/rsCYAXACoAVACsAVgCsAFgBsAJgBcC2Sx66untavcHpxeXqtWOMj93bzHK7+xjj9fH28ANNAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwTRc0rCYAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgBs0UXt64fnmT1e7m9mlkOTBx8Lzt4EYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQBb9FF+e3b+2+/xNx3h4E0AVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbBFH+W/9u9zu6z/r/gR7qofMH3w8ePZmwCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXA+qc81gRgBcAKgBUAKwBWAKwAWAGwAmAFwL4B2okhqaI7NQ4AAAAASUVORK5CYII=",
}

# ---------------------------------------------------------------------------
# Seed data definitions
# ---------------------------------------------------------------------------

SEED_USERS = [
    {"username": "alice_dev", "nickname": "Alice"},
    {"username": "bob_tester", "nickname": "Bob"},
    {"username": "charlie_ops", "nickname": "Charlie"},
    {"username": "dana_design", "nickname": "Dana"},
]

SEED_ROOMS = [
    {"room_id": "general", "topic": "General discussion for the team"},
    {"room_id": "random", "topic": "Off-topic and fun stuff"},
    {"room_id": "dev", "topic": "Development discussion and code reviews"},
]

SEED_CONVERSATIONS = {
    "general": [
        ("alice_dev", "Hey everyone! Good morning."),
        ("bob_tester", "Morning! Anyone up for a standup?"),
        ("charlie_ops", "I'm in. Just finished deploying the latest build."),
        ("dana_design", "Morning all. I pushed some new mockups to the shared folder."),
        ("alice_dev", "Nice! I'll take a look after lunch."),
        ("bob_tester", "The test suite is green on main btw"),
        ("charlie_ops", "Great, I'll promote to staging then"),
        ("dana_design", "Quick question — should we use the new design system tokens for the dashboard?"),
        ("alice_dev", "Yes absolutely. I already started migrating the sidebar."),
        ("bob_tester", "Make sure to update the snapshot tests if you change the sidebar"),
        ("charlie_ops", "Heads up: I'm rotating the API keys at 2pm. There might be a brief blip."),
        ("dana_design", "Noted. I'll pause my E2E tests around then."),
        ("alice_dev", "Should we document the key rotation process somewhere?"),
        ("charlie_ops", "Good call. I'll add it to the runbook after lunch."),
        ("bob_tester", "Anyone else having trouble with the staging DB? Queries are super slow."),
        ("charlie_ops", "Yeah I noticed that too. Looks like the vacuum job didn't run last night."),
        ("alice_dev", "I can take a look at the cron config if you want"),
        ("charlie_ops", "That would be great, thanks Alice"),
        ("dana_design", "New color palette proposal in the design channel btw. Would love feedback."),
        ("bob_tester", "Oh nice, I like the darker accents"),
        ("alice_dev", "Same. The contrast ratios look much better."),
        ("dana_design", "Thanks! I ran them all through the WCAG checker this time"),
        ("charlie_ops", "Deploy to staging is done. v2.4.1 is live there now."),
        ("bob_tester", "Running smoke tests... one sec"),
        ("bob_tester", "All green! Ship it."),
        ("alice_dev", "Awesome. Great work everyone."),
        ("charlie_ops", "Pushing to prod in 10 minutes. Last chance to object."),
        ("dana_design", "No objections from me"),
        ("alice_dev", "Go for it"),
        ("bob_tester", "Full send"),
        ("charlie_ops", "Prod deploy complete. Monitoring dashboards look clean."),
        ("alice_dev", "Perfect. I'm heading out for the day. See you all tomorrow!"),
        ("bob_tester", "Later Alice!"),
        ("dana_design", "Bye! Great day everyone."),
        ("charlie_ops", "See ya. I'll keep an eye on the metrics overnight."),
        ("bob_tester", "Oh wait, one more thing — the weekly report is due Friday. Who's writing it this week?"),
        ("charlie_ops", "I think it's Dana's turn"),
        ("dana_design", "Yep, I've got it. Will send a draft Thursday afternoon."),
        ("bob_tester", "Cool, thanks Dana"),
        ("alice_dev", "Actually still here — just wanted to say the new onboarding flow metrics look great. 40% improvement in completion rate."),
        ("dana_design", "That's amazing! The simplified form really made a difference."),
        ("bob_tester", "We should write a blog post about that"),
        ("charlie_ops", "Agreed. Good data to share externally."),
        ("alice_dev", "Ok NOW I'm actually leaving. Night everyone!"),
        ("bob_tester", "Night!"),
        ("charlie_ops", "Night!"),
        ("dana_design", "Goodnight!"),
        ("bob_tester", "Alright I'm out too. Catch everyone tomorrow."),
        ("charlie_ops", "Same. Signing off."),
        ("dana_design", "One last thing — I updated the Figma with the final icon set. Link in the design channel."),
        ("charlie_ops", "Thanks Dana, bookmarked it."),
        ("dana_design", "Ok goodnight for real this time"),
        # --- next morning ---
        ("charlie_ops", "Morning team. Prod metrics from overnight look solid. Zero errors."),
        ("bob_tester", "Morning! That's what I like to hear."),
        ("alice_dev", "Hey all. Coffee acquired, ready to go."),
        ("dana_design", "Good morning! I have the weekly report draft if anyone wants to review before I send it."),
        ("bob_tester", "Sure, drop the link"),
        ("dana_design", "It's in the shared drive under Reports/Week-12.md"),
        ("alice_dev", "Reading it now... looks good. Maybe add a line about the onboarding metrics?"),
        ("dana_design", "Oh good call, I forgot to include that. Adding now."),
        ("charlie_ops", "Also mention the staging DB fix from yesterday. That was a real save."),
        ("bob_tester", "Agreed. Alice's cron fix prevented a lot of headaches."),
        ("alice_dev", "Aw thanks. It was a one-liner honestly."),
        ("charlie_ops", "The best fixes usually are"),
        ("bob_tester", "So what's the plan for today? Sprint planning?"),
        ("alice_dev", "Yeah, we have the planning meeting at 10. Did everyone groom the backlog?"),
        ("charlie_ops", "I added estimates to the infra tickets last night"),
        ("dana_design", "Design tickets are all sized and have mockups attached"),
        ("bob_tester", "I've got the test tickets ready too. A few need acceptance criteria though."),
        ("alice_dev", "Let's finalize those in the meeting. I'll pull up the board."),
        ("charlie_ops", "Quick thing before that — the SSL cert for api.staging expires next week. I'll renew it today."),
        ("bob_tester", "Good catch. Those expiry emails always end up in spam somehow."),
        ("alice_dev", "We should automate cert renewal with Let's Encrypt"),
        ("charlie_ops", "It's on my list. Just haven't had time to set up certbot."),
        ("dana_design", "Can we also talk about the mobile responsive issues in planning? I filed three bugs yesterday."),
        ("bob_tester", "Yeah I saw those. The sidebar collapse is definitely broken on tablets."),
        ("alice_dev", "I'll pick those up. Should be quick CSS fixes."),
        ("dana_design", "Thanks Alice. I included screenshots in each ticket."),
        ("charlie_ops", "Meeting in 5. Everyone ready?"),
        ("bob_tester", "Ready"),
        ("alice_dev", "Yep"),
        ("dana_design", "Let's do it"),
        # --- post planning meeting ---
        ("alice_dev", "Good meeting. I think we have a solid sprint ahead."),
        ("bob_tester", "Agreed. I like that we kept scope manageable this time."),
        ("charlie_ops", "Famous last words"),
        ("dana_design", "lol Charlie always the optimist"),
        ("bob_tester", "He's not wrong though. Remember sprint 14?"),
        ("alice_dev", "We don't talk about sprint 14."),
        ("charlie_ops", "Anyway, I'm starting on the Kubernetes migration ticket. Wish me luck."),
        ("bob_tester", "Good luck. I'll have the test environment ready for you by noon."),
        ("dana_design", "I'm going to finalize the notification center designs. Quick question — do we want to support inline images in notifications?"),
        ("alice_dev", "Let's keep v1 simple. Text only with a link to the source."),
        ("bob_tester", "Agree. We can always add rich content later."),
        ("dana_design", "Makes sense. Simpler to test too."),
        ("charlie_ops", "Quick update: SSL cert renewed. Also noticed our Docker images are getting big. 1.2GB for the backend."),
        ("alice_dev", "Yikes. Are we using a slim base image?"),
        ("charlie_ops", "We're on python:3.12 which is the full image. Should switch to python:3.12-slim."),
        ("bob_tester", "That usually cuts it in half at least"),
        ("charlie_ops", "I'll make a PR for it. Also going to add a multi-stage build."),
        ("dana_design", "Is it lunch time yet?"),
        ("bob_tester", "It's 11:15 Dana"),
        ("dana_design", "So... early lunch?"),
        ("alice_dev", "Ha. Let's push to noon at least."),
        ("charlie_ops", "Speaking of food, who's handling the team lunch order for Thursday?"),
        ("bob_tester", "I can do it. Same place as last time? The taco place was great."),
        ("alice_dev", "Yes please. I want that birria quesadilla again."),
        ("dana_design", "The fish tacos were incredible"),
        ("charlie_ops", "I'm getting the burrito bowl. Easy choice."),
        ("bob_tester", "Alright, I'll set up the group order and share the link."),
        ("alice_dev", "Hey quick question — is anyone using the `/api/search` endpoint? Thinking about refactoring it."),
        ("bob_tester", "The frontend uses it for the message search feature. Why?"),
        ("alice_dev", "The query builder is really messy. I want to switch to a proper full-text search approach."),
        ("charlie_ops", "SQLite has FTS5 built in. Would be a nice improvement."),
        ("bob_tester", "Make sure the existing behavior doesn't break. I have a bunch of tests covering edge cases."),
        ("alice_dev", "For sure. I'll run the full test suite before and after."),
        ("dana_design", "Report is sent! Got good feedback from the PM already."),
        ("bob_tester", "Nice! What did they say?"),
        ("dana_design", "They loved the metrics section. Want us to present at the all-hands next week."),
        ("charlie_ops", "Oh cool. Who's presenting?"),
        ("alice_dev", "I vote Dana since she wrote most of it"),
        ("dana_design", "I can do the design and metrics parts. Can someone cover the technical bits?"),
        ("charlie_ops", "I'll cover the infrastructure improvements"),
        ("bob_tester", "And I'll talk about the test coverage improvements. We went from 67% to 89%."),
        ("alice_dev", "That's a great story to tell. Let's prep slides tomorrow."),
        ("dana_design", "I'll set up the slide deck and share it tonight."),
        ("charlie_ops", "Heads up everyone: I'm restarting the staging server in 5 minutes for the Docker image update."),
        ("bob_tester", "Noted. Pausing my test run."),
        ("alice_dev", "Thanks for the warning"),
        ("charlie_ops", "Staging is back up. New image is only 480MB. Down from 1.2GB."),
        ("bob_tester", "That's a huge improvement!"),
        ("alice_dev", "Nice work Charlie"),
        ("dana_design", "Does that affect deploy times too?"),
        ("charlie_ops", "Yep, deploys went from 4 minutes to about 90 seconds"),
        ("bob_tester", "I love when infra improvements just make everything better"),
        ("alice_dev", "Ok I'm deep in the search refactor. Going heads-down for a bit."),
        ("bob_tester", "Same, grinding through the tablet responsive bugs."),
        ("dana_design", "I'm in Figma if anyone needs me. Notification designs are coming along nicely."),
        ("charlie_ops", "I'll be in Terraform land. Pray for me."),
        ("bob_tester", "Thoughts and prayers"),
        ("alice_dev", "May your state files be uncorrupted"),
        ("dana_design", "lol"),
        # --- end of afternoon ---
        ("bob_tester", "Tablet bugs are fixed. Three PRs ready for review."),
        ("alice_dev", "I'll review them after I push my search refactor."),
        ("charlie_ops", "K8s cluster is provisioned. Tomorrow I'll start migrating services."),
        ("dana_design", "Notification designs are done! 12 screens total. Sharing the Figma link now."),
        ("bob_tester", "12 screens? That's thorough."),
        ("dana_design", "Covers all the states: empty, loading, unread, read, error, grouped by type..."),
        ("alice_dev", "Love the attention to detail. The empty state illustration is cute."),
        ("dana_design", "Thanks! I spent way too long on that little bell character."),
        ("charlie_ops", "Alright I'm wrapping up. Good productive day everyone."),
        ("bob_tester", "Same here. See you all tomorrow."),
        ("alice_dev", "Night team! Great day."),
        ("dana_design", "Goodnight everyone!"),
    ],
    "random": [
        ("bob_tester", "Has anyone tried that new coffee place on 5th?"),
        ("dana_design", "Yes! The cold brew is amazing"),
        ("alice_dev", "I'm more of a tea person tbh"),
        ("charlie_ops", "The real question is: tabs or spaces?"),
        ("bob_tester", "oh no, not this again..."),
        ("alice_dev", "Spaces. Obviously. Fight me."),
        ("charlie_ops", "I use tabs and I'm not ashamed"),
        ("dana_design", "I just let the formatter handle it honestly"),
        ("bob_tester", "That's the only correct answer Dana"),
        ("alice_dev", "Ok but what about semicolons in JS?"),
        ("charlie_ops", "Now THAT's a real debate"),
        ("bob_tester", "No semicolons. Prettier handles it."),
        ("dana_design", "I add them because it feels wrong not to"),
        ("alice_dev", "Psychopath behavior"),
        ("dana_design", "Excuse me??"),
        ("alice_dev", "Kidding! Mostly."),
        ("charlie_ops", "Anyway, what's everyone doing this weekend?"),
        ("bob_tester", "Hiking if the weather holds up"),
        ("dana_design", "Farmers market in the morning, then probably painting"),
        ("alice_dev", "I'm going to try to beat my speedrun time on Celeste"),
        ("charlie_ops", "Nice, what's your PB?"),
        ("alice_dev", "42 minutes. Trying to get under 40."),
        ("bob_tester", "Respect. I could never."),
        ("dana_design", "Has anyone watched that new series on Netflix? The one about the space station?"),
        ("charlie_ops", "Orbital? Yeah it's pretty good"),
        ("bob_tester", "I binged the whole thing last weekend. The ending is wild."),
        ("alice_dev", "NO SPOILERS"),
        ("bob_tester", "I wasn't going to!"),
        ("dana_design", "I'm on episode 3. So far so good."),
        ("charlie_ops", "It gets way better around ep 5"),
        ("alice_dev", "Ok adding it to my list"),
        ("bob_tester", "Random thought: why do we park in driveways and drive on parkways?"),
        ("charlie_ops", "Please go home Bob"),
        ("dana_design", "lol"),
        ("alice_dev", "He's got a point though"),
        ("bob_tester", "Thank you Alice. A true ally."),
        ("charlie_ops", "Speaking of random, I found the best meme about deployment yesterday"),
        ("bob_tester", "Share it!"),
        ("charlie_ops", "It's a picture of a dog sitting in a burning room saying 'this is fine' with a caption 'deploying on Friday'"),
        ("alice_dev", "Accurate"),
        ("dana_design", "Too real"),
        ("bob_tester", "We literally deployed on a Friday last week"),
        ("charlie_ops", "And nothing broke! We're getting better."),
        ("alice_dev", "Let's not jinx it"),
        ("dana_design", "Ok lunch break. Anyone want anything from that Thai place?"),
        ("bob_tester", "Pad Thai please!"),
        ("alice_dev", "Green curry for me"),
        ("charlie_ops", "I'm good, brought my lunch today"),
        ("bob_tester", "Look at Mr. Responsible over here"),
        ("charlie_ops", "I'm trying to save money ok"),
        ("dana_design", "Alright, orders noted. Back in 20."),
        # --- after lunch ---
        ("dana_design", "Food is here!"),
        ("bob_tester", "You're a hero Dana"),
        ("alice_dev", "This green curry is perfect. Thank you."),
        ("charlie_ops", "I'm regretting my sad desk sandwich right now"),
        ("bob_tester", "You brought that on yourself Charlie"),
        ("dana_design", "There's extra spring rolls if you want some"),
        ("charlie_ops", "Ok twist my arm"),
        ("alice_dev", "Speaking of food takes — pineapple on pizza?"),
        ("bob_tester", "Absolutely. Hawaiian pizza is elite."),
        ("charlie_ops", "You're dead to me Bob"),
        ("dana_design", "I'm team pineapple honestly"),
        ("alice_dev", "Same. The sweet and salty combo works."),
        ("charlie_ops", "I can't believe I work with these people"),
        ("bob_tester", "What's YOUR controversial food take Charlie?"),
        ("charlie_ops", "Ketchup on eggs is perfectly fine"),
        ("alice_dev", "...that IS controversial"),
        ("dana_design", "I mean it's not WRONG"),
        ("bob_tester", "It's a little wrong"),
        ("charlie_ops", "You put pineapple on pizza, you don't get to judge me"),
        ("alice_dev", "Fair point lol"),
        # --- music debate ---
        ("dana_design", "What does everyone listen to while coding? I need new music."),
        ("alice_dev", "Lo-fi hip hop beats to study/relax to. Obviously."),
        ("bob_tester", "I'm a movie soundtracks person. Hans Zimmer all day."),
        ("charlie_ops", "Death metal"),
        ("dana_design", "...really?"),
        ("charlie_ops", "No. Jazz mostly. Sometimes ambient electronic."),
        ("bob_tester", "I knew the death metal was a bit"),
        ("charlie_ops", "You don't know my life Bob"),
        ("alice_dev", "I went through a phase of listening to video game OSTs. The Celeste soundtrack is incredible."),
        ("dana_design", "Oh I love that! Also the Stardew Valley soundtrack is so cozy."),
        ("bob_tester", "The Hades soundtrack goes hard too"),
        ("charlie_ops", "Ok that one I agree with"),
        ("alice_dev", "If you want something chill, try Tycho. Great for focus mode."),
        ("dana_design", "Adding all of these to a playlist. Thanks everyone!"),
        ("bob_tester", "We should make a shared team playlist"),
        ("charlie_ops", "Collaborative Spotify playlist? I'm in."),
        ("alice_dev", "I'll create it. Team Vibes or something?"),
        ("bob_tester", "Call it 'Merge Conflict'"),
        ("dana_design", "That's perfect actually"),
        ("charlie_ops", "Seconded. Merge Conflict it is."),
        ("alice_dev", "Done. Link in the team drive. Add your favorites."),
        # --- pets ---
        ("bob_tester", "Completely unrelated but my cat just knocked my coffee off the desk"),
        ("dana_design", "Oh no! Is the laptop ok?"),
        ("bob_tester", "Laptop is fine. My dignity is not."),
        ("charlie_ops", "What's the cat's name?"),
        ("bob_tester", "Pixel. She's a menace."),
        ("alice_dev", "Pixel is a great name for a tech person's cat"),
        ("dana_design", "I have a corgi named Biscuit. He sits under my desk all day."),
        ("charlie_ops", "I need a photo of Biscuit immediately"),
        ("alice_dev", "Seconded"),
        ("dana_design", "Ask and you shall receive. Check the pet channel."),
        ("bob_tester", "WE HAVE A PET CHANNEL?"),
        ("dana_design", "We do now. I just made one."),
        ("charlie_ops", "Best channel in this whole app"),
        ("alice_dev", "I don't have pets but I'm absolutely here for the content"),
        ("bob_tester", "Pixel photo incoming"),
        ("charlie_ops", "I have two cockatiels named Git and Hub"),
        ("alice_dev", "You did NOT name your birds Git and Hub"),
        ("charlie_ops", "I absolutely did"),
        ("bob_tester", "That is the most DevOps thing I've ever heard"),
        ("dana_design", "I love it. Do they sing?"),
        ("charlie_ops", "Hub knows the Mario theme. Git just screams."),
        ("alice_dev", "Git just screams. Sounds about right."),
        ("bob_tester", "lmaooo"),
        # --- random debates continued ---
        ("dana_design", "Ok serious question: what's the best text editor?"),
        ("alice_dev", "VS Code. Next question."),
        ("charlie_ops", "Vim. And I will die on this hill."),
        ("bob_tester", "How do you exit vim though?"),
        ("charlie_ops", "I've been stuck in vim since 2014 and this is a cry for help"),
        ("alice_dev", "hahahaha"),
        ("dana_design", "I use Figma for everything including writing code"),
        ("bob_tester", "Please tell me that's a joke"),
        ("dana_design", "It is. I use VS Code like a normal person."),
        ("charlie_ops", "Normal is relative in this field"),
        ("alice_dev", "Anyone tried Zed? The new editor? It's insanely fast."),
        ("bob_tester", "I tried it for a week. It's nice but I miss my VS Code extensions."),
        ("charlie_ops", "Extensions are golden handcuffs"),
        ("dana_design", "What's everyone's must-have extension?"),
        ("alice_dev", "GitLens. Can't live without it."),
        ("bob_tester", "Error Lens. Shows errors inline right in the editor."),
        ("charlie_ops", "Remote SSH. I do all my editing on remote servers."),
        ("dana_design", "Peacock. I color-code my editor windows by project."),
        ("bob_tester", "That's actually genius Dana"),
        ("alice_dev", "I'm stealing that idea"),
        ("charlie_ops", "Ok I'm going to force myself to do actual work now. This channel is a trap."),
        ("bob_tester", "See you in 10 minutes when you come back"),
        ("charlie_ops", "...probably"),
        ("dana_design", "This channel is self-care Charlie"),
        ("alice_dev", "She's right. Breaks are important for productivity."),
        ("bob_tester", "That sounds like something you'd read on a motivational poster in a WeWork"),
        ("alice_dev", "Because it was. There's one right outside the bathroom."),
        ("dana_design", "I'm framing that quote"),
        ("charlie_ops", "Ok for real this time. Back to work. BYE."),
        ("bob_tester", "Bye Charlie. Enjoy vim."),
        ("alice_dev", ":wq"),
        ("charlie_ops", "I hate this channel"),
        ("dana_design", "No you don't"),
        ("charlie_ops", "No I don't"),
        ("bob_tester", "Wholesome ending to a random thread. Screenshot saved."),
        ("alice_dev", "This is going in the all-hands presentation right?"),
    ],
    "dev": [
        ("alice_dev", "I'm working on the new auth flow. Should be done by EOD."),
        ("bob_tester", "Can you add some integration tests for that?"),
        ("alice_dev", "Already on it. Using the new test fixtures."),
        ("charlie_ops", "Reminder: we need to update the CI pipeline for the new deps"),
        ("dana_design", "The new login page design is ready for implementation"),
        ("alice_dev", "Thanks Dana! I'll reference those when building the UI"),
        ("bob_tester", "I found a flaky test in the message search module. Looking into it."),
        ("charlie_ops", "Was it the one that depends on timestamp ordering?"),
        ("bob_tester", "Yep, exactly. Race condition in the async handler."),
        ("alice_dev", "I saw that one too. The fix is to use an atomic counter instead of timestamps."),
        ("bob_tester", "That's what I was thinking. PR incoming."),
        ("charlie_ops", "Make sure to add a regression test for it"),
        ("bob_tester", "Way ahead of you"),
        ("dana_design", "Question: should the error states use red or our warning orange?"),
        ("alice_dev", "Red for errors, orange for warnings. Let's keep them distinct."),
        ("dana_design", "Makes sense. I'll update the component library."),
        ("charlie_ops", "The new monitoring dashboard is up btw. Check grafana.internal/dashboards"),
        ("bob_tester", "Ooh nice. I can see the request latency graphs."),
        ("alice_dev", "p99 is at 120ms. Not bad but we should aim for under 100."),
        ("charlie_ops", "Most of the latency is in the DB queries. We need to add some indexes."),
        ("bob_tester", "I can profile the slow queries this afternoon"),
        ("alice_dev", "That would be great. Start with the message search endpoint — that one's the worst."),
        ("charlie_ops", "Also the room list query does a full table scan when you have 50+ rooms"),
        ("bob_tester", "Yikes. Ok I'll look at both."),
        ("dana_design", "While we're on performance — the frontend bundle is 2.3MB. Can we tree-shake some of that?"),
        ("alice_dev", "Yeah, I noticed we're importing all of lodash when we only use like 3 functions."),
        ("bob_tester", "Classic"),
        ("charlie_ops", "Just import what you need: import debounce from 'lodash/debounce'"),
        ("alice_dev", "I'll do a pass on the imports this sprint"),
        ("dana_design", "That should help. Also the SVG icons are huge — we should switch to an icon font or sprite sheet."),
        ("alice_dev", "Good idea. Let's add that to the sprint backlog."),
        ("charlie_ops", "PR #247 is ready for review. It's the WebSocket reconnection logic."),
        ("bob_tester", "I'll take a look"),
        ("alice_dev", "Me too. How did you handle the backoff?"),
        ("charlie_ops", "Exponential backoff with jitter. Starts at 1s, maxes at 30s."),
        ("bob_tester", "That's the right approach. Does it preserve the subscription state?"),
        ("charlie_ops", "Yep, it replays room.join for all previously joined rooms on reconnect."),
        ("alice_dev", "Nice. What about messages that arrived while disconnected?"),
        ("charlie_ops", "It uses the ?since= parameter to fetch anything missed."),
        ("bob_tester", "LGTM. Approving."),
        ("alice_dev", "Same, looks solid. One minor nit on the variable naming but not blocking."),
        ("charlie_ops", "I'll fix that before merging. Thanks for the quick review!"),
        ("dana_design", "Hey, the A/B test results for the new onboarding are in."),
        ("alice_dev", "And?"),
        ("dana_design", "Variant B (the simplified form) wins by a huge margin. 40% better completion rate."),
        ("bob_tester", "Wow that's massive"),
        ("charlie_ops", "Ship it."),
        ("alice_dev", "Agreed. Let's make variant B the default."),
        ("dana_design", "Already updated the feature flag. Rolling out to 100% now."),
        ("bob_tester", "I'll remove the old variant code in a cleanup PR"),
        ("alice_dev", "Don't forget to remove the feature flag config too"),
        ("bob_tester", "Yep, I'll clean up the whole thing"),
        ("charlie_ops", "One more thing — we should update the API docs. The new endpoints aren't documented yet."),
        ("alice_dev", "I can do that. Which endpoints are missing?"),
        ("charlie_ops", "The room folder endpoints and the new plugin API."),
        ("alice_dev", "On it. Should have the docs updated by tomorrow."),
        ("bob_tester", "I'll add example requests/responses to the test suite too. Those double as docs."),
        ("dana_design", "The swagger UI already auto-generates a lot of it. Just needs descriptions."),
        ("alice_dev", "True. I'll focus on the descriptions and examples then."),
        ("charlie_ops", "Great. I think that covers everything for today's standup."),
        ("bob_tester", "Shortest standup ever. Love it."),
        ("dana_design", "Efficient team is efficient"),
        ("alice_dev", "Back to coding then. Talk later!"),
        ("charlie_ops", "One sec — anyone want to pair on the caching layer this afternoon?"),
        ("alice_dev", "I'm in. 2pm work?"),
        ("charlie_ops", "Perfect. I'll set up the branch."),
        ("bob_tester", "Can I sit in? Want to understand the caching strategy for the test suite."),
        ("charlie_ops", "Of course. The more eyes the better."),
        ("dana_design", "I'll skip the pairing but let me know if you need any UI for cache invalidation controls."),
        ("alice_dev", "Will do. We might need a 'clear cache' button in the admin panel."),
        ("dana_design", "Easy. I'll have a mockup ready by tomorrow."),
        ("charlie_ops", "Alright, see everyone at 2. Going to grab lunch."),
        # --- pairing session recap ---
        ("charlie_ops", "Ok the pairing session went great. We've got a two-layer cache: in-memory LRU + Redis."),
        ("alice_dev", "The LRU handles hot data, Redis handles the warm tier. Invalidation is event-driven."),
        ("bob_tester", "I learned a ton watching you two work through that. The cache stampede protection is clever."),
        ("charlie_ops", "Yeah the lock-and-recompute pattern is key. Prevents thundering herd on cache misses."),
        ("dana_design", "Did you end up needing that admin UI for cache controls?"),
        ("alice_dev", "Definitely. We want a button to flush specific cache namespaces."),
        ("dana_design", "I'll prioritize the mockup. Should have it by EOD."),
        ("bob_tester", "I'm writing the cache integration tests now. How should I handle cache warmup in the test fixtures?"),
        ("charlie_ops", "Use a separate Redis DB for tests. I'll add the config. Just use REDIS_DB=1 for tests."),
        ("alice_dev", "Also make sure to flush between test runs so there's no bleed."),
        ("bob_tester", "Good point. I'll add that to the conftest."),
        # --- new bug discussion ---
        ("bob_tester", "Found something weird. When a user leaves a room and rejoins, their unread count is wrong."),
        ("alice_dev", "Wrong how? Too high or too low?"),
        ("bob_tester", "Too high. It's counting messages from when they weren't a member."),
        ("charlie_ops", "That's probably the membership timestamp not being updated on rejoin."),
        ("alice_dev", "Let me check... yeah, the rejoin path just sets status='active' but doesn't update joined_at."),
        ("bob_tester", "So the unread query uses joined_at to filter, but it's the original join date, not the rejoin date."),
        ("alice_dev", "Exactly. Easy fix. We need to update joined_at on rejoin. One line change."),
        ("charlie_ops", "Should we also store the leave timestamp? Might be useful for audit trails."),
        ("alice_dev", "That's a good idea but let's scope this fix small. Just the joined_at update."),
        ("bob_tester", "Agreed. I'll file a separate ticket for the leave audit trail."),
        ("alice_dev", "PR is up. #252. It's literally a one-line diff."),
        ("bob_tester", "Reviewing... LGTM. Clean fix."),
        ("charlie_ops", "Approved. Merge it."),
        ("alice_dev", "Merged. Bob can you verify the fix?"),
        ("bob_tester", "Testing now... unread count is correct after rejoin. Ship it."),
        # --- security discussion ---
        ("charlie_ops", "Heads up: I ran a dependency audit this morning. We have 3 medium vulnerabilities."),
        ("alice_dev", "In what packages?"),
        ("charlie_ops", "Two in transitive deps of the markdown parser, one in the old version of pyjwt."),
        ("bob_tester", "pyjwt is easy. Just bump the version."),
        ("charlie_ops", "Already did that one. The markdown parser ones are trickier. Upstream hasn't patched yet."),
        ("alice_dev", "What kind of vulns? XSS?"),
        ("charlie_ops", "One is a ReDoS in the regex parser. The other is an HTML injection in the sanitizer."),
        ("alice_dev", "We should switch to markdown-it. It's been more actively maintained."),
        ("bob_tester", "That's a bigger change though. Want to timebox it?"),
        ("alice_dev", "Fair. Let's give it half a day. If it's not clean by then, we pin and revisit next sprint."),
        ("charlie_ops", "I'll handle the migration. The API is similar so it shouldn't be too bad."),
        ("dana_design", "Will the rendering change at all? I don't want the message formatting to look different."),
        ("charlie_ops", "Shouldn't. I'll do a visual comparison before and after."),
        ("dana_design", "Thanks. Let me know if you need me to check anything."),
        # --- database discussion ---
        ("bob_tester", "Profile results are in for the slow queries. Message search is doing a sequential scan on 500k rows."),
        ("alice_dev", "Oof. We definitely need that FTS5 index."),
        ("charlie_ops", "How big is the messages table right now?"),
        ("bob_tester", "About 500k rows, 200MB on disk. Not huge but the queries are still slow without indexes."),
        ("alice_dev", "FTS5 virtual table should handle this nicely. I'll set it up with triggers to keep it in sync."),
        ("charlie_ops", "Make sure to use the unicode61 tokenizer so non-ASCII search works."),
        ("alice_dev", "Good call. I almost forgot about that."),
        ("bob_tester", "The room list query was also bad. Added an index on room_members(username, room_id) and it went from 800ms to 2ms."),
        ("charlie_ops", "That's a 400x improvement. Wow."),
        ("alice_dev", "Indexes are magic. Until you have too many of them."),
        ("bob_tester", "PR #253 for the room list index. Should I include the FTS migration too?"),
        ("alice_dev", "No, keep them separate. FTS is a bigger change. I'll put it in its own PR."),
        # --- API design discussion ---
        ("dana_design", "Question about the notification API: should dismissed notifications disappear permanently or just be marked as read?"),
        ("alice_dev", "Marked as read. Users might want to go back and find them."),
        ("bob_tester", "Agree. Permanent deletion makes me nervous from a UX perspective."),
        ("charlie_ops", "From a data perspective, soft delete is better too. We can always purge old ones in a background job."),
        ("dana_design", "Makes sense. I'll add a 'show dismissed' toggle to the UI."),
        ("alice_dev", "Nice. Let's also add a 'mark all as read' button. That's always useful."),
        ("bob_tester", "And a 'dismiss all' for the bold ones among us"),
        ("charlie_ops", "Inbox zero energy"),
        ("dana_design", "Love it. Updated the mockups."),
        ("alice_dev", "I'm looking at the notification data model now. We'll need: id, user_id, type, title, body, link, read_at, dismissed_at, created_at"),
        ("charlie_ops", "Add a source_id and source_type too. So we can link back to the message or event that triggered it."),
        ("alice_dev", "Good thinking. Polymorphic source reference. I'll add that."),
        ("bob_tester", "Don't forget the delivery preferences. Users might want to disable certain notification types."),
        ("alice_dev", "That's a separate table. notification_preferences with user_id, type, enabled, created_at."),
        ("dana_design", "Should I design a notification preferences page too?"),
        ("alice_dev", "Yes please. Put it in Settings > Notifications."),
        ("dana_design", "On it."),
        # --- end of day ---
        ("charlie_ops", "Markdown parser migration is done. PR #254. Rendering looks identical."),
        ("alice_dev", "Reviewing now. The diff is surprisingly clean."),
        ("bob_tester", "Tests all pass. Nice work Charlie."),
        ("charlie_ops", "Thanks. The new parser is also 3x faster. Unexpected bonus."),
        ("alice_dev", "Approved. Let's merge and deploy tomorrow morning after a soak test overnight on staging."),
        ("charlie_ops", "Smart. I'll deploy to staging now and we can check it first thing tomorrow."),
        ("bob_tester", "I set up a load test to run against staging overnight. 10 req/s for 8 hours."),
        ("alice_dev", "That's thorough. Should catch any memory leaks."),
        ("dana_design", "Notification preferences mockup is done. Six screens. Sharing now."),
        ("bob_tester", "That was fast!"),
        ("dana_design", "I had a head start from the settings page patterns we already established."),
        ("alice_dev", "These look great Dana. The toggle grouping by category is really intuitive."),
        ("charlie_ops", "Can we get a 'quiet hours' feature in there too? I don't want pings at 2am."),
        ("dana_design", "Adding it. Good idea."),
        ("bob_tester", "If Charlie's getting paged at 2am we have bigger problems"),
        ("charlie_ops", "You'd be surprised"),
        ("alice_dev", "Alright, wrapping up. Pushed the FTS5 PR. It can wait for review tomorrow."),
        ("bob_tester", "I'll review first thing. My overnight load test is running so I'm heading out too."),
        ("charlie_ops", "Same. Staging deploy is done. Fingers crossed for a clean overnight."),
        ("dana_design", "Night everyone! Don't forget we have the all-hands prep tomorrow at 11."),
        ("alice_dev", "Night! Good reminder, I'll prep my slides tonight."),
        ("bob_tester", "Later all!"),
        ("charlie_ops", "See you tomorrow. Don't let the bugs bite."),
    ],
}

PLUGIN_ID = "four43.room-type-chat"
REACTIONS_PLUGIN_ID = "four43.message-reactions"

# Reactions to apply after messages are seeded.
# Each entry: (room_id, message_index, [(username, emoji), ...])
# message_index is 0-based into SEED_CONVERSATIONS[room_id].
SEED_REACTIONS = [
    # general: "Hey everyone! Good morning."
    ("general", 0, [
        ("bob_tester", "👋"),
        ("charlie_ops", "👋"),
        ("dana_design", "👋"),
    ]),
    # general: "The test suite is green on main btw"
    ("general", 5, [
        ("alice_dev", "🎉"),
        ("charlie_ops", "🎉"),
        ("dana_design", "👍"),
    ]),
    # general: "Great, I'll promote to staging then"
    ("general", 6, [
        ("alice_dev", "🚀"),
        ("bob_tester", "🚀"),
    ]),
    # general: "All green! Ship it."
    ("general", 23, [
        ("alice_dev", "🎉"),
        ("charlie_ops", "🎉"),
        ("dana_design", "🎉"),
    ]),
    # general: "Full send"
    ("general", 28, [
        ("alice_dev", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😂"),
    ]),
    # general: "40% improvement in completion rate."
    ("general", 38, [
        ("bob_tester", "🚀"),
        ("charlie_ops", "🚀"),
        ("dana_design", "🎉"),
        ("bob_tester", "👀"),
    ]),
    # random: "The cold brew is amazing"
    ("random", 1, [
        ("alice_dev", "☕"),
        ("charlie_ops", "👍"),
    ]),
    # random: "tabs or spaces?"
    ("random", 3, [
        ("bob_tester", "😂"),
        ("alice_dev", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "I just let the formatter handle it honestly"
    ("random", 7, [
        ("bob_tester", "👍"),
        ("alice_dev", "👍"),
        ("charlie_ops", "👍"),
    ]),
    # random: "Psychopath behavior"
    ("random", 13, [
        ("bob_tester", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😮"),
    ]),
    # random: "42 minutes. Trying to get under 40."
    ("random", 21, [
        ("bob_tester", "👀"),
        ("charlie_ops", "👀"),
        ("dana_design", "🚀"),
    ]),
    # random: "NO SPOILERS"
    ("random", 25, [
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
        ("charlie_ops", "😂"),
    ]),
    # random: deploying on Friday meme
    ("random", 37, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
        ("alice_dev", "👍"),
    ]),
    # random: "Pad Thai please!"
    ("random", 44, [
        ("dana_design", "👍"),
    ]),
    # dev: "I'm working on the new auth flow. Should be done by EOD."
    ("dev", 0, [
        ("bob_tester", "👍"),
        ("charlie_ops", "🚀"),
    ]),
    # dev: "Race condition in the async handler."
    ("dev", 8, [
        ("alice_dev", "👀"),
        ("charlie_ops", "👀"),
    ]),
    # dev: "LGTM. Approving."
    ("dev", 40, [
        ("alice_dev", "👍"),
        ("charlie_ops", "❤️"),
    ]),
    # dev: "40% better completion rate."
    ("dev", 45, [
        ("alice_dev", "🎉"),
        ("bob_tester", "🎉"),
        ("charlie_ops", "🚀"),
        ("dana_design", "❤️"),
    ]),
    # dev: "Ship it."
    ("dev", 47, [
        ("alice_dev", "🚀"),
        ("bob_tester", "🚀"),
        ("dana_design", "🚀"),
    ]),
    # dev: "Shortest standup ever. Love it."
    ("dev", 61, [
        ("alice_dev", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😂"),
    ]),
    # --- reactions for expanded general messages ---
    # general: "Morning team. Prod metrics from overnight look solid. Zero errors."
    ("general", 53, [
        ("alice_dev", "👍"),
        ("bob_tester", "🎉"),
    ]),
    # general: "Famous last words"
    ("general", 85, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # general: "We don't talk about sprint 14."
    ("general", 88, [
        ("bob_tester", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😮"),
    ]),
    # general: "SSL cert renewed. Also noticed our Docker images are getting big. 1.2GB"
    ("general", 95, [
        ("alice_dev", "👀"),
        ("bob_tester", "👀"),
    ]),
    # general: "They loved the metrics section. Want us to present at the all-hands next week."
    ("general", 118, [
        ("alice_dev", "🎉"),
        ("bob_tester", "🎉"),
        ("charlie_ops", "🎉"),
    ]),
    # general: "We went from 67% to 89%."
    ("general", 123, [
        ("alice_dev", "🚀"),
        ("charlie_ops", "🚀"),
        ("dana_design", "🎉"),
    ]),
    # general: "Staging is back up. New image is only 480MB. Down from 1.2GB."
    ("general", 129, [
        ("alice_dev", "🚀"),
        ("bob_tester", "🚀"),
        ("dana_design", "👍"),
    ]),
    # general: "I'll be in Terraform land. Pray for me."
    ("general", 138, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # general: "May your state files be uncorrupted"
    ("general", 140, [
        ("bob_tester", "😂"),
        ("charlie_ops", "😂"),
    ]),
    # general: "Notification designs are done! 12 screens total."
    ("general", 145, [
        ("alice_dev", "👀"),
        ("bob_tester", "👀"),
        ("charlie_ops", "🎉"),
    ]),
    # general: "Thanks! I spent way too long on that little bell character."
    ("general", 149, [
        ("alice_dev", "❤️"),
        ("bob_tester", "❤️"),
        ("charlie_ops", "❤️"),
    ]),
    # --- reactions for expanded random messages ---
    # random: "Absolutely. Hawaiian pizza is elite."
    ("random", 60, [
        ("charlie_ops", "😮"),
        ("alice_dev", "👍"),
    ]),
    # random: "You're dead to me Bob"
    ("random", 61, [
        ("bob_tester", "😂"),
        ("alice_dev", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "Ketchup on eggs is perfectly fine"
    ("random", 66, [
        ("alice_dev", "😮"),
        ("bob_tester", "😮"),
        ("dana_design", "👀"),
    ]),
    # random: "Death metal"
    ("random", 75, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "Call it 'Merge Conflict'"
    ("random", 89, [
        ("alice_dev", "🎉"),
        ("charlie_ops", "🎉"),
        ("dana_design", "🎉"),
    ]),
    # random: "Pixel. She's a menace."
    ("random", 97, [
        ("alice_dev", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "❤️"),
    ]),
    # random: "I have two cockatiels named Git and Hub"
    ("random", 108, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "Hub knows the Mario theme. Git just screams."
    ("random", 113, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "I've been stuck in vim since 2014 and this is a cry for help"
    ("random", 120, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "Peacock. I color-code my editor windows by project."
    ("random", 133, [
        ("alice_dev", "👀"),
        ("bob_tester", "👀"),
        ("charlie_ops", "👀"),
    ]),
    # random: ":wq"
    ("random", 146, [
        ("bob_tester", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😂"),
    ]),
    # random: "No I don't"
    ("random", 149, [
        ("alice_dev", "❤️"),
        ("bob_tester", "❤️"),
        ("dana_design", "❤️"),
    ]),
    # --- reactions for expanded dev messages ---
    # dev: "Ok the pairing session went great."
    ("dev", 73, [
        ("bob_tester", "🎉"),
        ("dana_design", "👍"),
    ]),
    # dev: "Exactly. Easy fix. We need to update joined_at on rejoin."
    ("dev", 90, [
        ("bob_tester", "👍"),
        ("charlie_ops", "👍"),
    ]),
    # dev: "Testing now... unread count is correct after rejoin. Ship it."
    ("dev", 98, [
        ("alice_dev", "🎉"),
        ("charlie_ops", "🎉"),
    ]),
    # dev: "Added an index on room_members... went from 800ms to 2ms."
    ("dev", 120, [
        ("alice_dev", "🚀"),
        ("charlie_ops", "🚀"),
        ("dana_design", "👀"),
    ]),
    # dev: "That's a 400x improvement. Wow."
    ("dev", 121, [
        ("alice_dev", "👀"),
        ("bob_tester", "👀"),
    ]),
    # dev: "Inbox zero energy"
    ("dev", 132, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
    # dev: "Markdown parser migration is done. PR #254."
    ("dev", 142, [
        ("alice_dev", "👍"),
        ("bob_tester", "👍"),
    ]),
    # dev: "The new parser is also 3x faster. Unexpected bonus."
    ("dev", 145, [
        ("alice_dev", "🚀"),
        ("bob_tester", "🚀"),
        ("dana_design", "🎉"),
    ]),
    # dev: "If Charlie's getting paged at 2am we have bigger problems"
    ("dev", 156, [
        ("alice_dev", "😂"),
        ("charlie_ops", "😂"),
        ("dana_design", "😂"),
    ]),
    # dev: "See you tomorrow. Don't let the bugs bite."
    ("dev", 163, [
        ("alice_dev", "😂"),
        ("bob_tester", "😂"),
        ("dana_design", "😂"),
    ]),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def check_server(base_url: str) -> bool:
    """Verify the server is running."""
    try:
        resp = requests.get(f"{base_url}/api/server", timeout=3)
        return resp.status_code == 200
    except requests.ConnectionError:
        return False


# ---------------------------------------------------------------------------
# Crypto helpers (matches frontend crypto.js format)
# ---------------------------------------------------------------------------

def b64url_encode(data: bytes) -> str:
    """Base64url encode without padding (matches JS arrayBufferToBase64)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _rsa_private_key_to_jwk(private_key) -> dict:
    """Export RSA private key as a JWK dict (matches Web Crypto format)."""
    pub = private_key.public_key().public_numbers()
    priv = private_key.private_numbers()

    def _int_b64(n, length=None):
        byte_len = length or (n.bit_length() + 7) // 8
        return b64url_encode(n.to_bytes(byte_len, "big"))

    key_size = private_key.key_size // 8
    half = key_size // 2

    return {
        "kty": "RSA",
        "alg": "RSA-OAEP-256",
        "ext": True,
        "key_ops": ["decrypt"],
        "n": _int_b64(pub.n, key_size),
        "e": _int_b64(pub.e, 3),
        "d": _int_b64(priv.d, key_size),
        "p": _int_b64(priv.p, half),
        "q": _int_b64(priv.q, half),
        "dp": _int_b64(priv.dmp1, half),
        "dq": _int_b64(priv.dmq1, half),
        "qi": _int_b64(priv.iqmp, half),
    }


def _rsa_public_key_to_jwk(private_key) -> dict:
    """Export RSA public key as a JWK dict (matches Web Crypto format)."""
    pub = private_key.public_key().public_numbers()
    key_size = private_key.key_size // 8
    return {
        "kty": "RSA",
        "alg": "RSA-OAEP-256",
        "ext": True,
        "key_ops": ["encrypt"],
        "n": b64url_encode(pub.n.to_bytes(key_size, "big")),
        "e": b64url_encode(pub.e.to_bytes(3, "big")),
    }


def generate_rsa_keypair():
    """Generate an RSA-OAEP 2048-bit key pair."""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def encrypt_room_key_for_user(aes_key_bytes: bytes, rsa_private_key) -> str:
    """Encrypt a raw AES key with an RSA public key, return base64url string."""
    public_key = rsa_private_key.public_key()
    encrypted = public_key.encrypt(
        aes_key_bytes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return b64url_encode(encrypted)


def encrypt_room_key_for_admin(aes_key_bytes: bytes) -> str:
    """Encrypt a raw AES key with the admin user's stored public key."""
    jwk = json.loads(ADMIN_USER["encryption_public_key"])
    # Reconstruct RSA public key from JWK n and e
    n_bytes = base64.urlsafe_b64decode(jwk["n"] + "==")
    e_bytes = base64.urlsafe_b64decode(jwk["e"] + "==")
    n = int.from_bytes(n_bytes, "big")
    e = int.from_bytes(e_bytes, "big")
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
    public_key = RSAPublicNumbers(e, n).public_key()
    encrypted = public_key.encrypt(
        aes_key_bytes,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return b64url_encode(encrypted)


def encrypt_message(aes_key_bytes: bytes, plaintext: str, epoch: int = 0) -> str:
    """Encrypt a message with AES-GCM, returning JSON matching frontend format."""
    iv = os.urandom(12)
    aesgcm = AESGCM(aes_key_bytes)
    ct = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    return json.dumps({
        "v": 1,
        "epoch": epoch,
        "iv": b64url_encode(iv),
        "ct": b64url_encode(ct),
    })


# {username: rsa_private_key} — populated during user creation, used to encrypt room keys
seed_user_keys: dict = {}

# {room_id: aes_key_bytes} — populated during room key init, used to encrypt messages
room_aes_keys: dict[str, bytes] = {}


# ---------------------------------------------------------------------------
# Phase 1: Create users via direct DB
# ---------------------------------------------------------------------------

def insert_admin_user():
    """Insert the hardcoded admin user row if it doesn't already exist."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT username FROM users WHERE username = ?",
            (ADMIN_USER["username"],),
        ).fetchone()
        if existing:
            print(f"  {ADMIN_USER['username']}: already exists, skipping")
            return

        # Build the row, converting avatar from base64
        row = {k: v for k, v in ADMIN_USER.items() if k != "avatar_data_b64"}
        row["avatar_data"] = base64.b64decode(ADMIN_USER["avatar_data_b64"])

        columns = list(row.keys())
        placeholders = ", ".join("?" for _ in columns)
        col_names = ", ".join(columns)
        conn.execute(
            f"INSERT INTO users ({col_names}) VALUES ({placeholders})",
            [row[c] for c in columns],
        )
        conn.commit()
        print(f"  {ADMIN_USER['username']}: inserted (admin)")


def create_seed_users() -> dict[str, str]:
    """Create seed users, generate encryption keys, and return {username: session_token} mapping.

    Also populates the global ``seed_user_keys`` dict with RSA private keys
    so we can encrypt room keys for each user later.
    """
    global seed_user_keys

    # Temporarily set registration mode to 'open' so users are auto-approved
    original_mode = get_setting("registration_mode", "approval_required")
    set_setting("registration_mode", "open")

    tokens = {}
    for user in SEED_USERS:
        username = user["username"]

        # Check if already exists (idempotent)
        with get_db() as conn:
            row = conn.execute(
                "SELECT username FROM users WHERE username = ?", (username,)
            ).fetchone()
            if row:
                print(f"  {username}: already exists, skipping")
                tokens[username] = create_session_token(username)
                # Generate a key even for existing users (needed for room key encryption)
                if username not in seed_user_keys:
                    seed_user_keys[username] = generate_rsa_keypair()
                    pub_jwk = json.dumps(_rsa_public_key_to_jwk(seed_user_keys[username]))
                    conn.execute(
                        "UPDATE users SET encryption_public_key = ? WHERE username = ?",
                        (pub_jwk, username),
                    )
                    conn.commit()
                continue

        try:
            dummy_cred = f"seed-credential-{username}"
            dummy_key = f"seed-pubkey-{username}"
            _approval_code, auto_approved = create_pending_user(
                username, dummy_cred, dummy_key
            )
            tokens[username] = create_session_token(username)
            status = "active" if auto_approved else "pending"

            # Generate and store encryption key pair
            rsa_key = generate_rsa_keypair()
            seed_user_keys[username] = rsa_key
            pub_jwk = json.dumps(_rsa_public_key_to_jwk(rsa_key))
            with get_db() as conn:
                conn.execute(
                    "UPDATE users SET encryption_public_key = ? WHERE username = ?",
                    (pub_jwk, username),
                )
                conn.commit()

            print(f"  {username}: created ({status}) with encryption keys")
        except Exception as e:
            print(f"  {username}: ERROR - {e}")

    # Restore original registration mode
    set_setting("registration_mode", original_mode)
    return tokens


# ---------------------------------------------------------------------------
# Phase 2: Create rooms via HTTP API
# ---------------------------------------------------------------------------

def create_seed_rooms(tokens: dict[str, str], base_url: str):
    """Create rooms and add all users (seed + admin) as members."""
    # Use first seed user as room creator (will be owner)
    creator = SEED_USERS[0]["username"]
    headers = auth_headers(tokens[creator])

    all_usernames = [u["username"] for u in SEED_USERS] + [ADMIN_USER["username"]]

    for room in SEED_ROOMS:
        room_id = room["room_id"]

        # Create room
        resp = requests.post(
            f"{base_url}/api/rooms",
            json={"room_id": room_id, "room_type": "chat"},
            headers=headers,
        )
        if resp.status_code == 200:
            print(f"  #{room_id}: created")
        elif resp.status_code == 400:
            print(f"  #{room_id}: already exists, skipping creation")
        else:
            print(f"  #{room_id}: ERROR {resp.status_code} - {resp.text}")
            continue

        # Set topic
        requests.patch(
            f"{base_url}/api/rooms/{room_id}",
            json={"topic": room["topic"]},
            headers=headers,
        )

        # Add all other users as members
        for username in all_usernames:
            if username == creator:
                continue
            resp = requests.post(
                f"{base_url}/api/rooms/{room_id}/members",
                json={"username": username},
                headers=headers,
            )
            if resp.status_code == 200:
                print(f"  #{room_id}: added {username}")
            elif "already" in resp.text.lower():
                pass  # silently skip
            else:
                print(f"  #{room_id}: failed to add {username} - {resp.text}")


# ---------------------------------------------------------------------------
# Phase 2.5: Initialize room encryption keys (HTTP API)
# ---------------------------------------------------------------------------

def init_room_keys(tokens: dict[str, str], base_url: str):
    """Generate an AES-GCM room key per room and encrypt it for every member."""
    all_usernames = [u["username"] for u in SEED_USERS] + [ADMIN_USER["username"]]
    # Use the first seed user to store keys (they have room access as creator)
    creator = SEED_USERS[0]["username"]
    creator_headers = auth_headers(tokens[creator])

    for room in SEED_ROOMS:
        room_id = room["room_id"]

        # Check if keys already exist for this room
        resp = requests.get(
            f"{base_url}/api/rooms/{room_id}/keys",
            headers=creator_headers,
        )
        if resp.status_code == 200 and len(resp.json()) > 0:
            print(f"  #{room_id}: keys already exist, skipping")
            continue

        # Generate a random 256-bit AES key
        aes_key_bytes = os.urandom(32)
        room_aes_keys[room_id] = aes_key_bytes

        for username in all_usernames:
            if username == ADMIN_USER["username"]:
                encrypted = encrypt_room_key_for_admin(aes_key_bytes)
            else:
                rsa_key = seed_user_keys.get(username)
                if not rsa_key:
                    print(f"  #{room_id}: no RSA key for {username}, skipping")
                    continue
                encrypted = encrypt_room_key_for_user(aes_key_bytes, rsa_key)

            resp = requests.post(
                f"{base_url}/api/rooms/{room_id}/keys",
                json={"username": username, "encrypted_key": encrypted, "key_epoch": 0},
                headers=creator_headers,
            )
            if resp.status_code == 200:
                print(f"  #{room_id}: stored key for {username}")
            else:
                print(f"  #{room_id}: ERROR storing key for {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Phase 3: Seed messages via HTTP API
# ---------------------------------------------------------------------------

def seed_messages(tokens: dict[str, str], base_url: str):
    """Post seed conversations to rooms (encrypted with room keys)."""
    for room_id, conversation in SEED_CONVERSATIONS.items():
        # Check if room already has messages (skip if so)
        check_headers = auth_headers(tokens[SEED_USERS[0]["username"]])
        resp = requests.get(
            f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages?since=0",
            headers=check_headers,
        )
        if resp.status_code == 200 and len(resp.json()) > 0:
            print(f"  #{room_id}: already has messages, skipping")
            continue

        aes_key = room_aes_keys.get(room_id)

        for username, content in conversation:
            if aes_key:
                encrypted_content = encrypt_message(aes_key, content, epoch=0)
                payload = {"content": encrypted_content, "content_type": "encrypted", "key_epoch": 0}
            else:
                payload = {"content": content, "content_type": "text"}

            resp = requests.post(
                f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages",
                json=payload,
                headers=auth_headers(tokens[username]),
            )
            if resp.status_code == 200:
                print(f"  #{room_id} <{username}> {content[:60]}")
            else:
                print(f"  #{room_id}: ERROR posting as {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Phase 4: Seed reactions via HTTP API
# ---------------------------------------------------------------------------

def seed_reactions(tokens: dict[str, str], base_url: str):
    """Add reactions to seeded messages."""
    reactions_url = f"{base_url}/api/plugins/{REACTIONS_PLUGIN_ID}/reactions"

    # Build a map of (room_id, message_index) -> message_id by fetching messages
    message_id_cache: dict[str, list[int]] = {}

    for room_id, msg_index, reactions in SEED_REACTIONS:
        # Fetch message IDs for this room if not cached
        if room_id not in message_id_cache:
            check_headers = auth_headers(tokens[SEED_USERS[0]["username"]])
            resp = requests.get(
                f"{base_url}/api/plugins/{PLUGIN_ID}/rooms/{room_id}/messages?since=0",
                headers=check_headers,
            )
            if resp.status_code != 200:
                print(f"  #{room_id}: ERROR fetching messages - {resp.status_code}")
                continue
            # Store message IDs in order
            message_id_cache[room_id] = [msg["id"] for msg in resp.json()]

        msg_ids = message_id_cache[room_id]
        if msg_index >= len(msg_ids):
            print(f"  #{room_id}: message index {msg_index} out of range ({len(msg_ids)} messages)")
            continue

        message_id = msg_ids[msg_index]

        for username, emoji in reactions:
            resp = requests.post(
                f"{reactions_url}/add",
                json={"message_id": message_id, "room_id": room_id, "emoji": emoji},
                headers=auth_headers(tokens[username]),
            )
            if resp.status_code == 200:
                print(f"  #{room_id} msg:{message_id} {emoji} by {username}")
            elif resp.status_code == 400 and "already exists" in resp.text.lower():
                pass  # silently skip duplicates
            else:
                print(f"  #{room_id}: ERROR reacting as {username} - {resp.status_code} {resp.text}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    base_url = os.environ.get("SKRIB_URL", "http://localhost:8000")

    # Phase 1: Direct DB — create users
    print("\n=== Phase 1: Creating users (direct DB) ===")
    init_db()
    insert_admin_user()
    tokens = create_seed_users()

    if not tokens:
        print("ERROR: No seed users created. Check errors above.")
        sys.exit(1)

    # Check server is running for HTTP phases
    print(f"\n=== Checking server at {base_url} ===")
    if not check_server(base_url):
        print("ERROR: Server is not running. Start it first:")
        print("  cd backend && uvicorn skrib.main:app --reload --host 0.0.0.0 --port 8000")
        sys.exit(1)
    print("Server is up!")

    # Phase 2: HTTP API — create rooms and add all users
    print("\n=== Phase 2: Creating rooms (HTTP API) ===")
    create_seed_rooms(tokens, base_url)

    # Phase 2.5: HTTP API — initialize room encryption keys
    print("\n=== Phase 2.5: Initializing room encryption keys (HTTP API) ===")
    init_room_keys(tokens, base_url)

    # Phase 3: HTTP API — seed encrypted messages
    print("\n=== Phase 3: Seeding messages (HTTP API) ===")
    seed_messages(tokens, base_url)

    # Phase 4: HTTP API — seed reactions
    print("\n=== Phase 4: Seeding reactions (HTTP API) ===")
    seed_reactions(tokens, base_url)

    print("\n=== Done! Refresh your browser to see the seeded data. ===")


if __name__ == "__main__":
    main()
