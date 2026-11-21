"""
Neon Object Storage Client (S3-Compatible)
------------------------------------------
Connects to Neon Object Storage using boto3 and standard AWS_* environment variables.
Handles storing and retrieving:
  - Agent git patches (.diff / .patch)
  - Full execution & terminal logs
  - Workspace snapshots
"""

import os
from pathlib import Path
from dotenv import load_dotenv
import boto3
from botocore.config import Config
from rich.console import Console

# Load environment variables from Backend/.env
load_dotenv()
console = Console()

# 1. Read Neon S3 Environment Variables
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
AWS_ENDPOINT_URL_S3 = os.getenv("AWS_ENDPOINT_URL_S3")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
NEON_STORAGE_BUCKET = os.getenv("NEON_STORAGE_BUCKET", "agent-artifacts")


class NeonObjectStorage:
    """
    Manages uploads and downloads with Neon Object Storage.
    """

    def __init__(self):
        # Check if full Neon cloud storage credentials exist in .env
        self.use_cloud = bool(
            AWS_ENDPOINT_URL_S3 and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
        )

        if self.use_cloud:
            # Initialize S3 client pointed to Neon's branch endpoint
            # force_path_style=True is required for Neon Object Storage
            self.s3_client = boto3.client(
                "s3",
                region_name=AWS_REGION,
                endpoint_url=AWS_ENDPOINT_URL_S3,
                aws_access_key_id=AWS_ACCESS_KEY_ID,
                aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
                config=Config(s3={"addressing_style": "path"})
            )
            self.bucket_name = NEON_STORAGE_BUCKET
            console.print(f"[green]✔ Connected to Neon Object Storage bucket: '{self.bucket_name}'[/green]")
        else:
            # Graceful local fallback on Drive D: so you can test before deploying cloud keys
            self.local_dir = Path("D:/Complex_backend/Cloud_native/artifacts")
            self.local_dir.mkdir(parents=True, exist_ok=True)
            console.print(f"[yellow]⚠ Neon S3 credentials not set in .env. Falling back to local disk: {self.local_dir}[/yellow]")

    def upload_patch(self, run_id: str, diff_content: str) -> str:
        """
        Uploads a generated git patch / diff to Neon Object Storage.
        Returns the object key.
        """
        key = f"runs/{run_id}/patch.diff"

        if self.use_cloud:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=diff_content.encode("utf-8"),
                ContentType="text/x-diff"
            )
        else:
            dest_path = self.local_dir / key
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            dest_path.write_text(diff_content, encoding="utf-8")

        console.print(f"[green]✔ Patch stored successfully at:[/green] [cyan]{key}[/cyan]")
        return key

    def upload_log(self, run_id: str, log_content: str) -> str:
        """
        Uploads full terminal stdout/stderr logs to Neon Object Storage.
        Returns the object key.
        """
        key = f"runs/{run_id}/terminal.log"

        if self.use_cloud:
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=log_content.encode("utf-8"),
                ContentType="text/plain"
            )
        else:
            dest_path = self.local_dir / key
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            dest_path.write_text(log_content, encoding="utf-8")

        console.print(f"[green]✔ Terminal log stored at:[/green] [cyan]{key}[/cyan]")
        return key

    def download_file(self, key: str) -> str:
        """
        Downloads and reads a text artifact from Neon Object Storage.
        """
        if self.use_cloud:
            response = self.s3_client.get_object(
                Bucket=self.bucket_name,
                Key=key
            )
            return response["Body"].read().decode("utf-8")
        else:
            dest_path = self.local_dir / key
            return dest_path.read_text(encoding="utf-8")

    def download_patch(self, run_id: str) -> str | None:
        """
        Downloads the git patch for a given run_id.
        Returns the patch text, or None if not found.
        """
        key = f"runs/{run_id}/patch.diff"
        try:
            return self.download_file(key)
        except Exception:
            return None


if __name__ == "__main__":
    console.rule("[bold magenta]Testing Neon Object Storage Client")

    storage = NeonObjectStorage()

    sample_run_id = "test-agent-run-001"
    sample_diff = (
        "--- a/src/calculator.py\n"
        "+++ b/src/calculator.py\n"
        "@@ -1,2 +1,3 @@\n"
        "-def divide(a, b): return a / b\n"
        "+def divide(a, b):\n"
        "+    return a / b if b != 0 else None\n"
    )

    # 1. Test Upload
    console.print("\n[cyan]Uploading sample patch to Neon Object Storage...[/cyan]")
    patch_key = storage.upload_patch(sample_run_id, sample_diff)

    # 2. Test Download
    console.print("\n[cyan]Downloading and verifying patch from Neon Object Storage...[/cyan]")
    downloaded_diff = storage.download_file(patch_key)
    
    assert downloaded_diff == sample_diff, "Downloaded content mismatch!"
    console.print(f"[bold green]✔ Integrity Verified! Content matches perfectly ({len(downloaded_diff)} bytes).[/bold green]")
