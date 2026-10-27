"""Create the named Modal worker secret from secure runtime variables; never print credentials."""
import argparse
import os
from urllib.parse import urlsplit

import modal


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--website-url",required=True)
    p.add_argument("--secret-name",default="football-vision-production-api")
    args=p.parse_args()
    website=urlsplit(args.website_url)
    if website.scheme!="https" or not website.hostname or website.username or website.query or website.fragment or website.path not in ("","/"):
        p.error("Use the published website's HTTPS origin, without a path or credentials.")
    token=os.environ.get("WORKER_STORAGE_TOKEN")
    if not token or len(token)<32:
        p.error("The existing WORKER_STORAGE_TOKEN must be configured securely.")
    values={"WORKER_API_URL":args.website_url.rstrip("/")+"/api/internal/worker-jobs","STORAGE_PROVIDER":"replit",
            "WORKER_STORAGE_URL":args.website_url.rstrip("/")+"/api/internal/worker-storage",
            "WORKER_STORAGE_TOKEN":token}
    try:
        modal.Secret.objects.create(args.secret_name,values,allow_existing=False)
    except Exception as error:
        p.exit(1,f"Modal secret creation failed ({type(error).__name__}); no existing secret was overwritten.\n")
    print("Created the named worker secret. No credential values were printed.")


if __name__=="__main__":
    main()
