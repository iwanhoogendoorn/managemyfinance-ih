#!/usr/bin/env python3
"""
Creates two-level subcategories and re-files existing transactions into them.

Safety rule throughout: a transaction only moves when its merchant matches a rule below. Anything
unmatched stays exactly where it is, on the parent category — a wrong subcategory is worse than no
subcategory, and "Food" is never wrong for something already in Food.

Dry run by default; --commit writes categories.json and the ledger CSVs.
"""
import csv, glob, json, os, re, sys
from collections import Counter, defaultdict

FIN = os.path.expanduser("~/Documents/IWAN-REMOTE-VAULT/Finance")
LEDGER = f"{FIN}/data/ledger/generic"

TX_COLUMNS = [
    "id", "date", "accountId", "description", "counterparty", "amount", "currency",
    "categoryId", "type", "code", "source", "raw", "notes", "ticker", "assetClass",
    "shares", "price", "fee", "tax", "action", "attachmentPath",
]

# parent name -> [(sub name, icon, [keywords...])]. First matching rule wins, so put the specific
# ones first. Keywords are matched case-insensitively as substrings of the description.
PLAN = {
    "Food": [
        ("Groceries", "shopping-cart", [
            "jumbo", "albert heijn", "ah to go", "hanos", "aldi", "lidl", "plus", "dirk", "hoogvliet",
            "makro", "sahan supermarkt", "toko ", "toko-", "amazing oriental", "kellys expat",
            "vishandel", "poelier", "slagerij", "supermarkt", "supermercado", "fresh market",
            "islamitische slagerij", "melkow", "de groente en frui", "h.j.j. oudsen",
        ]),
        ("Takeaway & snacks", "package", [
            "thuisbezorgd", "uber eats", "talabat", "takeaway", "sitedish", "multisafepay",
            "mcdonald", "kfc", "domino", "new york pizza", "nypd", "burger king", "taco bell",
            "bram ladage", "smullers", "snackkiosk", "friet", "loempia", "shaamihuis",
            "caribbean snacks", "tornado potato", "krispy kreme", "candy", "ijsmaker", "ijssalon",
            "heladeria", "roll d up ice", "ice cream", "banketbakkerij", "bakkerij", "bakery",
            "koekela", "de vries bakery", "luciennes bakk", "ten to three baker", "cakebear",
            "machi machi", "yoyo! fresh tea", "yoyo fresh tea", "bubble bear", "i'tea supply",
            "hero tea cafe", "coffeecompany", "sunset coffee", "espresso", "chaiiwala",
            "tim hortons", "lindt", "jamin", "de zoete verle",
        ]),
        ("Restaurants", "utensils", []),  # empty keywords = catch-all for the rest of Food (see below)
    ],
    "Travel & Vacation": [
        ("Cruises", "ship", ["cruise", "seven seas"]),
        ("Flights", "plane", ["klm", "easyjet", "ryanair", "dohop", "airline", "transavia", "tui fly"]),
        ("Hotels & stays", "bed-double", [
            "hotel", "htl ", "austria trend", "villa leonie", "atlantis the palm", "courtyard",
            "bw royal", "five hotels", "five hotel", "postillion", "vandervalkh", "fletcher",
            "guldenberg", "radisson", "resort",
        ]),
        ("Travel extras", "luggage", [
            "airalo", "holafly", "mobimatter", "customs and border", "vf services", "onward travel",
        ]),
    ],
    "Auto & Transport": [
        ("Parking", "circle-parking", [
            "parking", "parkeer", "parkeren", "q park", "q-park", "interparking", "apcoa",
            "parken den haag", "park.rdam", "zuidpoort garage", "wegschap tunne", "alexandrium parking",
            "easypark", "yellowbrick",
        ]),
        ("Taxi & rideshare", "car-taxi-front", [
            "uber", "taxi", "careem", "bolt", "pytche",
        ]),
        ("Fuel", "fuel", ["shell", "tango", "tinq", "totalenergies", "roebert tankstation", "esso", "bp"]),
        ("Public transport", "train-front", [
            "transport for london", "ovpay", "belbim", "lime", "alpes-maritimes", "ov-chipkaart", "=ns",
        ]),
        ("Car", "car", [
            "nio ", "nio nextev", "autoser", "autowaspark", "boedelbak", "flitsmeister", "vignette",
            "mcwash",
        ]),
    ],
    "Entertainment": [
        ("Events & tickets", "ticket", [
            "ticketswap", "ticketmaster", "i-ticketz", "ticketpo", "paylogic", "idticketing",
            "ticketpay", "see tickets", "rotterdam ahoy", "fo events", "magic balloon",
        ]),
        ("Games", "gamepad-2", [
            "mtcgame", "mtc game", "g2g", "g2a", "z2u", "royalcdkeys", "itch.io", "playzone",
            "palace of games", "steampowered",
        ]),
        ("Apps & media", "monitor-play", [
            "apple", "itunes", "youtube", "google play", "google google stor", "google store",
            "tidal", "prime video", "amznprime", "qobuz", "reddit", "patreon", "buy me a coffee",
            "sharesub", "smart stb", "karafun", "recisio",
        ]),
        ("Attractions & outings", "ferris-wheel", [
            "pathé", "pathe", "kinepolis", "movie park", "schönbrunn", "schonbrunn", "selvatura",
            "global village", "luxor theater", "staatsbosbeheer", "swinging coaster", "amus",
            "deca dance", "grijpkraan", "nilo entertainment", "fun cooking", "gamestate",
            "walibi", "glowgolf", "gokarting", "getyourguide", "afc ajax",
        ]),
    ],
    "Business": [
        ("Music production", "music", [
            "volt music", "soundstorexl", "andor van reeven", "muziek service", "presonus", "splice",
            "auto tune", "sweetwater", "thomann", "kilohearts", "plugin boutique", "sonnox",
            "universal audio", "mixedinkey", "distrokid", "songtradr", "lalal", "musescore",
            "suno", "boombox.io", "my.music", "jamzone", "audionose", "vokaal", "mka music",
            "lennardig", "ns audio", "emma h music", "abletunes", "audible genius", "songtostems",
            "dj.studio", "scrapsaudio", "audiomidi", "bollypiano", "philicpiano", "kits.ai",
            "submithub", "juno download", "tonecontrol", "super publishing", "artist coaching",
        ]),
        ("Hosting & domains", "server", [
            "serverlama", "dediseedbo", "registrarco", "oxxa", "transip", "contabo", "eweka",
            "godaddy", "google cloud", "tweaknews", "realdebrid", "unraid", "strato",
        ]),
        ("Freelancers & services", "handshake", [
            "fiverr", "upwork", "upwrkescro", "belastingadviseurs", "oraclub",
            "salemedia", "gekko agency", "ttm productions", "pkm summit", "facebooktec",
        ]),
        ("Equipment & premises", "building-2", [
            "kaja horeca", "centurion deuren", "mybattery", "pijlman", "unifi", "camirafabrics",
            "office & more", "regus", "seats2meet", "wkx b.v.", "vbc group", "fs.com", "athom",
        ]),
        ("Software & AI tools", "app-window", [
            "obsidian", "notion", "microsoft", "msft", "adobe", "lastpass", "nordvpn", "github",
            "cursor", "openai", "anthropic", "midjourney", "heygen", "elevenlabs", "runway",
            "moonshot", "openrouter", "black forest labs", "miro.com", "workona", "clickup",
            "usemotion", "motion", "animaker", "freepik", "envato", "flaticon", "gumroad",
            "paddle", "fastspring", "creem", "flurly", "pebble dev", "lulu inc", "useviral", "moneybird",
        ]),
    ],
    "Shopping": [
        ("Marketplaces", "store", [
            "bol.com", "amazon", "aliexpress", "temu", "marktplaats", "ebay", "groupon", "vinted",
            "joom", "wehkamp", "riverty", "klarna", "tinka",
        ]),
        ("Electronics & tech", "cpu", [
            "bambu lab", "apple store", "sonos", "kiwi electronics", "coolblue", "sicomputers",
            "allekabels", "peak design", "mediamarkt", "media markt", "maxiaxi", "philips-hue",
            "philips hue", "cameranu", "belsimpel", "123adapter", "dell products",
        ]),
        ("Clothing & accessories", "shirt", [
            "bestseller", "only", "jack & jones", "pvh", "labfresh", "daka sport", "jd sports",
            "ray-ban", "samsonite", "wittchen", "swarovski", "pandora", "lucardi", "sons utrecht",
            "watchshop", "h&m", "hennes", "zara", "c&a", "we fashion", "wefashion", "mango",
            "about you", "peek", "snipes", "adidas", "daily paper", "the sting", "manfield",
            "charles tyrwhitt", "gymshark", "edel-optics", "pluto sport", "zalando", "thesting",
            "bijenkorf", "excelsior sport", "sports supplements",
        ]),
        ("Health & beauty", "sparkles", ["douglas", "rituals", "lush", "kruidvat", "etos"]),
        ("Home & living", "lamp", [
            "intratuin", "kwantum", "action", "wibra", "xenos", "flying tiger", "miniso", "normal",
            "blokker", "hema", "ikea", "hornbach",
        ]),
    ],
}

PALETTE_BY_PARENT = {}  # subcategories inherit the parent's colour so the card stays readable


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    commit = "--commit" in sys.argv
    categories = json.load(open(f"{FIN}/data/categories.json"))
    by_name = {c["name"]: c for c in categories}

    # ---- resolve/create subcategories ----
    created = []
    sub_ids = {}  # (parent, sub) -> id
    for parent_name, subs in PLAN.items():
        parent = by_name.get(parent_name)
        if not parent:
            print(f"FATAL: parent category {parent_name!r} not found")
            sys.exit(1)
        for sub_name, icon, _kw in subs:
            existing = next(
                (c for c in categories if c.get("parentId") == parent["id"] and c["name"] == sub_name), None
            )
            if existing:
                sub_ids[(parent_name, sub_name)] = existing["id"]
                continue
            cid = f"cat-user-{slug(sub_name)}-{slug(parent_name)[:6]}"
            sub_ids[(parent_name, sub_name)] = cid
            created.append({
                "id": cid,
                "name": sub_name,
                "color": parent["color"],
                "icon": icon,
                "aliases": [],
                "parentId": parent["id"],
            })

    # ---- classify existing transactions ----
    parent_id_to_name = {by_name[p]["id"]: p for p in PLAN if p in by_name}
    moves = {}          # tx id -> new category id
    per_sub = Counter()
    per_sub_eur = Counter()
    stayed = defaultdict(Counter)

    files = sorted(glob.glob(f"{LEDGER}/*.csv"))
    rows_by_file = {}
    for path in files:
        with open(path, newline="", encoding="utf-8") as f:
            rows_by_file[path] = list(csv.DictReader(f))

    for path, rows in rows_by_file.items():
        for row in rows:
            parent_name = parent_id_to_name.get(row["categoryId"])
            if not parent_name:
                continue
            desc = (row["description"] or "").lower()
            matched = None
            for sub_name, _icon, keywords in PLAN[parent_name]:
                if not keywords:
                    continue
                if any(desc.strip() == k[1:] if k.startswith("=") else k in desc for k in keywords):
                    matched = sub_name
                    break
            # Food's "Restaurants" is the catch-all for anything left that is food but neither a
            # supermarket nor a takeaway/snack — every remaining Food merchant is a place you ate at.
            if not matched and parent_name == "Food":
                matched = "Restaurants"
            if not matched:
                stayed[parent_name][row["description"]] += 1
                continue
            moves[row["id"]] = sub_ids[(parent_name, matched)]
            per_sub[(parent_name, matched)] += 1
            per_sub_eur[(parent_name, matched)] += abs(float(row["amount"]))

    # ---- report ----
    print(f"Subcategories to create: {len(created)}")
    for parent_name in PLAN:
        subs = [s for s in PLAN[parent_name]]
        total_moved = sum(per_sub[(parent_name, s[0])] for s in subs)
        remaining = sum(stayed[parent_name].values())
        print(f"\n{parent_name}  — {total_moved} filed, {remaining} staying on the parent")
        for sub_name, _icon, _kw in subs:
            n = per_sub[(parent_name, sub_name)]
            eur = per_sub_eur[(parent_name, sub_name)]
            print(f"    {n:5d} tx  EUR {eur:9,.0f}   {sub_name}")
        if remaining:
            top = stayed[parent_name].most_common(8)
            print(f"      staying put: " + ", ".join(f"{d} ({c})" for d, c in top) + (" …" if len(stayed[parent_name]) > 8 else ""))

    print(f"\nTotal transactions re-filed: {len(moves)}")

    if not commit:
        print("\nDRY RUN — nothing written. Re-run with --commit.")
        return

    # ---- write categories ----
    categories.extend(created)
    with open(f"{FIN}/data/categories.json", "w") as f:
        json.dump(categories, f, indent="\t")
    print(f"\nWrote {len(created)} new subcategories to categories.json")

    # ---- rewrite ledger files ----
    for path, rows in rows_by_file.items():
        changed = 0
        for row in rows:
            new_id = moves.get(row["id"])
            if new_id and row["categoryId"] != new_id:
                row["categoryId"] = new_id
                changed += 1
        if changed == 0:
            continue
        out = [TX_COLUMNS]
        for row in rows:
            out.append([row.get(c, "") for c in TX_COLUMNS])
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerows(out)
        print(f"  {os.path.basename(path)}: {changed} rows re-filed")

    print("\nDone. Reload the Finance plugin to see them.")


if __name__ == "__main__":
    main()
