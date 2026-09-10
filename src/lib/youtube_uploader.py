#!/usr/bin/env python3
import os
import sys
import json
import time
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import googleapiclient.discovery
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
AGENT_DATA_ROOT = Path(os.environ.get("AGENT_DATA_ROOT", "/home/ubuntu/agent-data"))
IFTV_TOKEN_DIR = Path(os.environ.get(
    "IFTV_TOKEN_DIR",
    AGENT_DATA_ROOT / "projects" / "if-tv-station"
))
TOKEN_FILE = str(IFTV_TOKEN_DIR / "token.json")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Config JSON file path required as argument"}))
        sys.exit(1)

    config_path = sys.argv[1]
    if not os.path.exists(config_path):
        print(json.dumps({"error": f"Config file not found: {config_path}"}))
        sys.exit(1)

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception as e:
        print(json.dumps({"error": f"Failed to parse config JSON: {e}"}))
        sys.exit(1)

    video_path = config.get("videoPath")
    title = config.get("title")
    description = config.get("description")
    subtitles = config.get("subtitles", [])
    channel = config.get("channel")
    if not channel or (isinstance(channel, str) and channel.lower() in ["default", "brainholestudio"]):
        channel = "BrainHoleStudio"

    global TOKEN_FILE
    TOKEN_FILE = str(IFTV_TOKEN_DIR / f"token_{channel}.json")

    if not video_path or not os.path.exists(video_path):
        print(json.dumps({"error": f"Video file not found: {video_path}"}))
        sys.exit(1)

    if not os.path.exists(TOKEN_FILE):
        print(json.dumps({"error": f"YouTube auth token not found at {TOKEN_FILE}. Please run login first."}))
        sys.exit(1)

    # 1. 載入 YouTube OAuth 憑證並自動刷新過期 Token，最後初始化 Client
    try:
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
        if creds and creds.expired and creds.refresh_token:
            sys.stderr.write(f"[Python] Token expired, refreshing credentials for channel: {channel}...\n")
            sys.stderr.flush()
            creds.refresh(Request())
            with open(TOKEN_FILE, "w") as token_file:
                token_file.write(creds.to_json())
            sys.stderr.write(f"[Python] Token refreshed and saved successfully.\n")
            sys.stderr.flush()
        youtube = googleapiclient.discovery.build("youtube", "v3", credentials=creds)
    except Exception as e:
        print(json.dumps({"error": f"Failed to initialize YouTube API client: {e}"}))
        sys.exit(1)

    # 2. 執行影片上傳 (Resumable Upload)
    try:
        body = {
            "snippet": {
                "title": title[:100],  # YouTube 限制 100 字元
                "description": description,
                "tags": ["IfTV", "WhatIf", "平行宇宙", "AI影片", "如果電視台"],
                "categoryId": "22"  # People & Blogs
            },
            "status": {
                "privacyStatus": "public",
                "selfDeclaredMadeForKids": False,
                "containsSyntheticMedia": True
            }
        }

        media = MediaFileUpload(video_path, chunksize=1024*1024, resumable=True)
        request = youtube.videos().insert(
            part="snippet,status",
            body=body,
            media_body=media
        )

        response = None
        max_retries = 5
        retry_count = 0
        while response is None:
            try:
                status, response = request.next_chunk()
                if status:
                    sys.stderr.write(f"[Python] Upload progress: {int(status.progress() * 100)}%\n")
                    sys.stderr.flush()
                retry_count = 0  # reset on success
            except HttpError as e:
                if e.resp.status in [500, 502, 503, 504] and retry_count < max_retries:
                    wait = 2 ** retry_count
                    sys.stderr.write(f"[Python] Upload error {e.resp.status}, retrying in {wait}s (attempt {retry_count+1}/{max_retries})...\n")
                    sys.stderr.flush()
                    time.sleep(wait)
                    retry_count += 1
                else:
                    raise

        video_id = response.get("id")
        if not video_id:
            print(json.dumps({"error": "Failed to retrieve video ID from upload response"}))
            sys.exit(1)

        sys.stderr.write(f"[Python] Video uploaded successfully! Video ID: {video_id}\n")
        sys.stderr.flush()

        # 3. 逐一上傳多國語系字幕
        for sub in subtitles:
            lang_code = sub.get("lang")
            lang_name = sub.get("name")
            sub_path = sub.get("path")

            if not sub_path or not os.path.exists(sub_path):
                sys.stderr.write(f"[Python] Subtitle file not found: {sub_path}, skipping...\n")
                continue

            sys.stderr.write(f"[Python] Uploading {lang_name} ({lang_code}) subtitles...\n")
            sys.stderr.flush()

            try:
                sub_media = MediaFileUpload(sub_path, mimetype="application/octet-stream", resumable=True)
                sub_request = youtube.captions().insert(
                    part="snippet",
                    body={
                        "snippet": {
                            "videoId": video_id,
                            "language": lang_code,
                            "name": lang_name,
                            "isDraft": False
                        }
                    },
                    media_body=sub_media
                )
                
                sub_response = None
                while sub_response is None:
                    _, sub_response = sub_request.next_chunk()
                
                sys.stderr.write(f"[Python] Uploaded {lang_name} subtitles successfully!\n")
                sys.stderr.flush()
            except Exception as sub_err:
                sys.stderr.write(f"[Python] Failed to upload subtitles for {lang_code}: {sub_err}\n")
                sys.stderr.flush()

        # 4. 回傳成功狀態與影片連結
        print(json.dumps({
            "status": "success",
            "video_id": video_id,
            "youtube_url": f"https://www.youtube.com/watch?v={video_id}"
        }))

    except Exception as upload_err:
        print(json.dumps({"error": f"YouTube video upload error: {upload_err}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
