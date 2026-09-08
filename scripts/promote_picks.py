"""Promote picks and clear rejects.

Rates every image flagged as a pick five stars and sets every reject's
rating to zero. Runs in the app console or the batch runner.
"""

import heeler

images = heeler.images()
picks = [image["id"] for image in images if image["flag"] == "pick"]
rejects = [image["id"] for image in images if image["flag"] == "reject"]

if picks:
    heeler.rate(picks, 5)
if rejects:
    heeler.rate(rejects, 0)

print(f"Promoted {len(picks)} picks; cleared {len(rejects)} reject ratings")
