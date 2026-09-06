from playwright.sync_api import sync_playwright
import json

ME = json.dumps({"playerId":"mike-d","pin":"1000"})

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2)
    pg = ctx.new_page()
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console:"+m.text) if m.type=="error" else None)
    pg.goto("http://localhost:8787/", wait_until="domcontentloaded")
    pg.evaluate(f"localStorage.setItem('pickem.me', '{ME}')")
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1200)
    pg.screenshot(path="/tmp/s_picks.png", full_page=True)

    pg.click("[data-tab='live']"); pg.wait_for_timeout(600)
    pg.screenshot(path="/tmp/s_live.png", full_page=True)

    pg.click("[data-tab='standings']"); pg.wait_for_timeout(1500)
    pg.screenshot(path="/tmp/s_standings.png", full_page=True)

    pg.click("[data-tab='admin']"); pg.wait_for_timeout(400)
    pg.fill("#apin","4321"); pg.click("#agO"); pg.wait_for_timeout(900)
    pg.screenshot(path="/tmp/s_admin.png", full_page=True)

    # dark mode, picks tab
    ctx2 = b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2, color_scheme="dark")
    pg2 = ctx2.new_page()
    pg2.on("pageerror", lambda e: errs.append("dark:"+str(e)))
    pg2.goto("http://localhost:8787/", wait_until="domcontentloaded")
    pg2.evaluate(f"localStorage.setItem('pickem.me', '{ME}')")
    pg2.reload(wait_until="networkidle"); pg2.wait_for_timeout(1200)
    pg2.click("[data-tab='live']"); pg2.wait_for_timeout(600)
    pg2.screenshot(path="/tmp/s_dark.png", full_page=True)
    print("ERRORS:", errs[:10] if errs else "none")
    b.close()
