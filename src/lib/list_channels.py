#!/usr/bin/env python3
import os
import sys
import json
import glob
from pathlib import Path
from google.oauth2.credentials import Credentials
import googleapiclient.discovery
from google.auth.transport.requests import Request

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
AGENT_DATA_ROOT = Path(os.environ.get("AGENT_DATA_ROOT", "/home/ubuntu/agent-data"))
IFTV_TOKEN_DIR = Path(os.environ.get(
    "IFTV_TOKEN_DIR",
    AGENT_DATA_ROOT / "projects" / "if-tv-station"
))

def get_channel_info(token_path):
    try:
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
        # 自動刷新過期 Token
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # 寫回更新後的憑證
            with open(token_path, "w") as token_file:
                token_file.write(creds.to_json())

        youtube = googleapiclient.discovery.build("youtube", "v3", credentials=creds)
        res = youtube.channels().list(mine=True, part="snippet").execute()
        
        if res.get("items"):
            item = res["items"][0]
            return {
                "title": item["snippet"]["title"],
                "customUrl": item["snippet"].get("customUrl", ""),
                "id": item["id"]
            }
    except Exception as e:
        sys.stderr.write(f"Error querying {token_path}: {e}\n")
    return None

def main():
    channels = []
    
    # 搜尋所有 token*.json 檔案
    token_files = glob.glob(str(IFTV_TOKEN_DIR / "token*.json"))
    
    for tf in token_files:
        filename = os.path.basename(tf)
        
        # 解析 Profile Key
        if filename == "token.json":
            profile_key = "default"
        else:
            profile_key = filename.replace("token_", "").replace(".json", "")
            
        # 僅保留 BrainHoleStudio 頻道
        if profile_key != "BrainHoleStudio":
            continue
            
        info = get_channel_info(tf)
        if info:
            info["profile"] = profile_key
            channels.append(info)
            
    print(json.dumps(channels, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
