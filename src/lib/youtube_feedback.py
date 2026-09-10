#!/usr/bin/env python3
import os
import sys
import json
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import googleapiclient.discovery

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
AGENT_DATA_ROOT = Path(os.environ.get("AGENT_DATA_ROOT", "/home/ubuntu/agent-data"))
IFTV_TOKEN_DIR = Path(os.environ.get(
    "IFTV_TOKEN_DIR",
    AGENT_DATA_ROOT / "projects" / "if-tv-station"
))

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Video ID required as argument"}))
        sys.exit(1)

    video_id = sys.argv[1]
    channel = sys.argv[2] if len(sys.argv) > 2 else "BrainHoleStudio"
    if channel.lower() in ["default", "brainholestudio"]:
        channel = "BrainHoleStudio"
    
    token_file = str(IFTV_TOKEN_DIR / f"token_{channel}.json")
    
    if not os.path.exists(token_file):
        print(json.dumps({"error": f"YouTube token not found: {token_file}"}))
        sys.exit(1)

    try:
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(token_file, "w") as tf:
                tf.write(creds.to_json())
        youtube = googleapiclient.discovery.build("youtube", "v3", credentials=creds)
    except Exception as e:
        print(json.dumps({"error": f"Failed to initialize YouTube API: {e}"}))
        sys.exit(1)

    # 1. Fetch video stats
    stats = {}
    try:
        video_resp = youtube.videos().list(part="statistics", id=video_id).execute()
        if video_resp.get("items"):
            item = video_resp["items"][0]
            v_stats = item.get("statistics", {})
            stats = {
                "views": int(v_stats.get("viewCount", 0)),
                "likes": int(v_stats.get("likeCount", 0)),
                "commentsCount": int(v_stats.get("commentCount", 0))
            }
    except Exception as e:
        stats = {"error": f"Failed to fetch stats: {e}"}

    # 2. Fetch top comments
    comments = []
    try:
        comment_resp = youtube.commentThreads().list(
            part="snippet",
            videoId=video_id,
            maxResults=10,
            order="relevance"
        ).execute()
        
        for item in comment_resp.get("items", []):
            snippet = item.get("snippet", {}).get("topLevelComment", {}).get("snippet", {})
            text = snippet.get("textDisplay", "")
            author = snippet.get("authorDisplayName", "")
            like_count = snippet.get("likeCount", 0)
            if text:
                comments.append({
                    "author": author,
                    "text": text,
                    "likes": like_count
                })
    except Exception as e:
        # Many videos have comments disabled or no comments yet
        pass

    print(json.dumps({
        "status": "success",
        "video_id": video_id,
        "statistics": stats,
        "comments": comments
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
