# 🎬 Stremio Overseerr Addon

A Stremio addon that lets you request movies and TV shows directly through Overseerr without leaving Stremio. Perfect for self-hosted media setups!

## ✨ Features

- **🎬 One-Click Requests**: Request movies, seasons, or entire series directly from Stremio
- **📺 Smart TV Options**: For episodes, choose between requesting the season or entire series
- **🔒 Privacy First**: Your configuration is encoded in your personal addon URL - no data stored
- **🏠 Self-Hostable**: Run locally via Docker for full network privacy
- **🌐 Public Option**: Use with publicly accessible Overseerr instances

## 🚀 Quick Start

### **For Public Overseerr Instances**

1. **Visit the configuration page**: [Your Vercel URL]
2. **Enter your details**:
   - Your TMDB API Key (get from [TMDB](https://www.themoviedb.org/settings/api))
   - Your Overseerr URL (e.g., `https://overseerr.example.com`)
   - Your Overseerr API Key (from Overseerr Settings → API Keys)
3. **Generate your personal addon URL**
4. **Install in Stremio**: Community Addons → Paste URL

### **For Local Network Users (Self-Hosting)**

If your Overseerr is on a local IP (`192.168.x.x`), self-host the addon:

```bash
# Quick Docker deployment
docker run -d -p 3000:3000 plsharevme/stremio-overseerr-addon:latest
Then visit http://your-local-ip:3000 and follow the configuration steps above.

🐳 Docker Deployment
Simple Docker Run
bash
docker run -d \
  --name stremio-overseerr-addon \
  -p 3000:3000 \
  plsharevme/stremio-overseerr-addon:latest
Docker Compose
yaml
version: '3.8'
services:
  stremio-overseerr-addon:
    image: plsharevme/stremio-overseerr-addon:latest
    container_name: stremio-overseerr-addon
    ports:
      - "3000:3000"
    restart: unless-stopped
Then run:

bash
docker-compose up -d
Access Your Instance
After deployment, access the configuration page at:

text
http://your-server-ip:3000
🎯 How It Works in Stremio
For Movies
Click the "🎬 Request Movie: 'Movie Title'" stream

A confirmation video plays while your request is sent to Overseerr

For TV Episodes
You get TWO clear options:

📺 Request Entire Season X - Request just this season

🏠 Request Complete Series (All Seasons) - Request the entire series

Request Behavior
✅ 5-minute cooldown per item to prevent duplicates

✅ Background processing - requests happen while video plays

✅ Overseerr integration - appears in your Overseerr request queue

🔧 Configuration
Required Information
TMDB API Key: Free from TMDB Settings

Overseerr URL: Your instance URL (public domain or local IP)

Overseerr API Key: Generate in Overseerr: Settings → API Keys

URL Examples
Public: https://overseerr.example.com

Local: http://192.168.1.100:5055

Local with domain: https://overseerr.local

🏗️ Architecture
How It Works
text
Stremio → Your Personal Addon URL → Overseerr Addon Server → Your Overseerr Instance
Important Notes
Public Overseerr: Use the Vercel-hosted version

Local Overseerr: Must self-host the addon on the same network

No Data Storage: Your config is encoded in the addon URL, not stored on servers

🔒 Privacy & Security
✅ No accounts required

✅ No data stored - configuration lives in your addon URL

✅ Your API keys stay with you

✅ Open source - completely transparent

✅ Self-hostable - no cloud dependencies when running locally

🐛 Troubleshooting
Common Issues
"Cannot test local IP configuration"

This is expected! The test can't reach your local network from the cloud

Your addon will work when used locally with Stremio

"Request not showing in Overseerr"

Check your Overseerr API key has correct permissions

Verify your Overseerr URL is accessible

Ensure TMDB API key is valid

"No streams showing in Stremio"

Verify you're using IMDb IDs (ttXXXXXXX) in your catalog

Check Stremio is using the correct addon URL

Debug Mode
Access these endpoints for debugging:

http://your-addon-url/health - Server status

http://your-addon-url/cleanup - Clear pending requests

🤝 Contributing
Contributions welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

Development Setup
bash
git clone [your-repo-url]
npm install
npm start
📝 License
This project is licensed under the MIT License - see the LICENSE file for details.

🙏 Acknowledgments
Stremio for the amazing media platform

Overseerr for fantastic request management

TMDB for comprehensive metadata
