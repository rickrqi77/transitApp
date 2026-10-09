//+------------------------------------------------------------------+
//|                                              GoldPriceAlert.mq5  |
//|                     XAUUSD Gold Price Alert System for MT5       |
//|  Syncs alerts from Cloudflare Worker, detects price crosses,     |
//|  and notifies server (Telegram sent by Worker).                  |
//+------------------------------------------------------------------+
#property copyright "Gold Alert System"
#property link      ""
#property version   "1.03"
#property description "XAUUSD gold price alert EA. Syncs with Cloudflare API."

//--- inputs
input string InpApiBaseUrl      = "https://your-worker.workers.dev"; // Cloudflare Worker base URL (no trailing slash)
input string InpApiToken        = "";                                 // API Token (same as Worker secret API_TOKEN)
input string InpSymbol          = "";                                 // Empty = chart symbol
input int    InpSyncSeconds     = 3;                                  // Server sync interval (seconds)
input bool   InpEnableTelegram  = true;                               // Notify Cloudflare on trigger (Telegram via Worker)
input bool   InpVerboseLog      = false;                              // true = log every heartbeat/price (fills Experts log)

//--- constants
#define MAX_ALERTS           10
#define HTTP_TIMEOUT_MS      8000
#define LOG_PREFIX           "[GoldAlert] "

//--- alert local state
struct AlertState
{
   int      id;
   double   price;
   bool     enabled;
   int      side;        // -1 = price below alert, +1 = price above alert, 0 = unknown
   bool     valid;
};

AlertState g_alerts[MAX_ALERTS];
int        g_alertCount     = 0;
int        g_configVersion  = -1;
string     g_symbol         = "";
double     g_prevMid        = 0.0;
bool       g_hasPrevPrice   = false;
bool       g_apiOk          = false;
bool       g_loggedApiOk    = false;
datetime   g_lastSyncTime   = 0;
datetime   g_lastErrorLog   = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print(LOG_PREFIX, "EA initialized");

   if(StringLen(InpApiBaseUrl) < 8)
   {
      Print(LOG_PREFIX, "ERROR: InpApiBaseUrl is empty or invalid");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(StringLen(InpApiToken) < 1)
   {
      Print(LOG_PREFIX, "ERROR: InpApiToken is empty");
      return(INIT_PARAMETERS_INCORRECT);
   }

   g_symbol = InpSymbol;
   if(StringLen(g_symbol) == 0)
      g_symbol = _Symbol;

   Print(LOG_PREFIX, "Symbol: ", g_symbol);
   Print(LOG_PREFIX, "API: ", InpApiBaseUrl);
   Print(LOG_PREFIX, "Sync interval: ", InpSyncSeconds, "s");

   if(!SymbolSelect(g_symbol, true))
      Print(LOG_PREFIX, "WARNING: SymbolSelect failed for ", g_symbol);

   ResetAlerts();

   int syncSec = InpSyncSeconds;
   if(syncSec < 1) syncSec = 1;
   if(!EventSetTimer(syncSec))
   {
      Print(LOG_PREFIX, "ERROR: EventSetTimer failed");
      return(INIT_FAILED);
   }

   // Immediate first sync
   SyncWithServer();

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print(LOG_PREFIX, "EA stopped. Reason=", reason);
}

//+------------------------------------------------------------------+
//| Timer: sync config + heartbeat (NOT in OnTick)                   |
//+------------------------------------------------------------------+
void OnTimer()
{
   SyncWithServer();
}

//+------------------------------------------------------------------+
//| Tick: local cross detection only (no HTTP)                       |
//+------------------------------------------------------------------+
void OnTick()
{
   double bid = 0.0, ask = 0.0, mid = 0.0;
   if(!GetPrices(bid, ask, mid))
      return;

   if(!g_hasPrevPrice)
   {
      g_prevMid = mid;
      g_hasPrevPrice = true;
      InitAlertSides(mid);
      return;
   }

   CheckCrosses(g_prevMid, mid);
   g_prevMid = mid;
}

//+------------------------------------------------------------------+
//| Reset local alerts                                               |
//+------------------------------------------------------------------+
void ResetAlerts()
{
   g_alertCount = 0;
   for(int i = 0; i < MAX_ALERTS; i++)
   {
      g_alerts[i].id = 0;
      g_alerts[i].price = 0.0;
      g_alerts[i].enabled = false;
      g_alerts[i].side = 0;
      g_alerts[i].valid = false;
   }
}

//+------------------------------------------------------------------+
//| Get bid/ask/mid from SymbolInfoTick                              |
//+------------------------------------------------------------------+
bool GetPrices(double &bid, double &ask, double &mid)
{
   MqlTick tick;
   if(!SymbolInfoTick(g_symbol, tick))
   {
      // Fallback
      bid = SymbolInfoDouble(g_symbol, SYMBOL_BID);
      ask = SymbolInfoDouble(g_symbol, SYMBOL_ASK);
      if(bid <= 0.0 || ask <= 0.0)
         return false;
   }
   else
   {
      bid = tick.bid;
      ask = tick.ask;
   }

   mid = (bid + ask) / 2.0;
   return true;
}

//+------------------------------------------------------------------+
//| Digits / point helpers                                           |
//+------------------------------------------------------------------+
int PriceDigits()
{
   long digits = SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
   if(digits < 0) digits = _Digits;
   return (int)digits;
}

string FormatPrice(const double price)
{
   return DoubleToString(price, PriceDigits());
}

//+------------------------------------------------------------------+
//| Initialize side for each alert based on current price            |
//+------------------------------------------------------------------+
void InitAlertSides(const double price)
{
   for(int i = 0; i < g_alertCount; i++)
   {
      if(!g_alerts[i].valid || !g_alerts[i].enabled)
         continue;
      if(price < g_alerts[i].price)
         g_alerts[i].side = -1;
      else if(price > g_alerts[i].price)
         g_alerts[i].side = 1;
      else
         g_alerts[i].side = 0; // exactly on level — wait for leave then re-cross
   }
}

//+------------------------------------------------------------------+
//| Cross detection                                                  |
//+------------------------------------------------------------------+
void CheckCrosses(const double prevPrice, const double currPrice)
{
   for(int i = 0; i < g_alertCount; i++)
   {
      if(!g_alerts[i].valid || !g_alerts[i].enabled)
         continue;

      double ap = g_alerts[i].price;

      // UP: previous below, current at/above
      if(prevPrice < ap && currPrice >= ap)
      {
         // Only fire if we were on the below side (or unknown after sync)
         if(g_alerts[i].side <= 0)
         {
            Print(LOG_PREFIX, "ALERT UP: ", FormatPrice(ap), "  curr=", FormatPrice(currPrice));
            if(InpEnableTelegram)
               SendTrigger(g_alerts[i].id, currPrice, ap, "UP");
            g_alerts[i].enabled = false; // one-shot: wait until user re-enables on web
            g_alerts[i].side = 1;
         }
         else
         {
            g_alerts[i].side = 1;
         }
      }
      // DOWN: previous above, current at/below
      else if(prevPrice > ap && currPrice <= ap)
      {
         if(g_alerts[i].side >= 0)
         {
            Print(LOG_PREFIX, "ALERT DOWN: ", FormatPrice(ap), "  curr=", FormatPrice(currPrice));
            if(InpEnableTelegram)
               SendTrigger(g_alerts[i].id, currPrice, ap, "DOWN");
            g_alerts[i].enabled = false;
            g_alerts[i].side = -1;
         }
         else
         {
            g_alerts[i].side = -1;
         }
      }
      else
      {
         // Update side without trigger while staying on one side
         if(currPrice < ap)
            g_alerts[i].side = -1;
         else if(currPrice > ap)
            g_alerts[i].side = 1;
      }
   }
}

//+------------------------------------------------------------------+
//| Sync: heartbeat + config fetch                                   |
//+------------------------------------------------------------------+
void SyncWithServer()
{
   double bid = 0.0, ask = 0.0, mid = 0.0;
   if(!GetPrices(bid, ask, mid))
   {
      LogErrorThrottled("ERROR: Cannot read prices for " + g_symbol);
      return;
   }

   if(InpVerboseLog)
      Print(LOG_PREFIX, "Price: ", FormatPrice(mid), "  bid=", FormatPrice(bid), "  ask=", FormatPrice(ask));

   // Heartbeat
   if(!PostHeartbeat(bid, ask, mid))
      return;

   // Config
   FetchConfig(mid);

   g_lastSyncTime = TimeCurrent();
}

//+------------------------------------------------------------------+
//| HTTP helpers                                                     |
//+------------------------------------------------------------------+
void LogErrorThrottled(const string msg)
{
   datetime now = TimeCurrent();
   if(g_lastErrorLog != 0 && (now - g_lastErrorLog) < 60)
      return;
   g_lastErrorLog = now;
   Print(LOG_PREFIX, msg);
}

string NormalizeBaseUrl()
{
   string base = InpApiBaseUrl;
   // strip trailing slash
   while(StringLen(base) > 0 && StringGetCharacter(base, StringLen(base) - 1) == '/')
      base = StringSubstr(base, 0, StringLen(base) - 1);
   return base;
}

string AuthHeaders()
{
   return "Content-Type: application/json\r\nAuthorization: Bearer " + InpApiToken + "\r\n";
}

bool HttpRequest(const string method, const string url, const string body,
                 string &outBody, int &outStatus)
{
   outBody = "";
   outStatus = -1;

   char post[];
   char result[];
   string resultHeaders = "";

   ArrayResize(post, 0);
   if(StringLen(body) > 0)
   {
      int n = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
      // StringToCharArray includes terminating 0 — remove it for HTTP body
      if(n > 0)
         ArrayResize(post, n - 1);
   }

   ResetLastError();
   int code = WebRequest(method, url, AuthHeaders(), HTTP_TIMEOUT_MS, post, result, resultHeaders);
   int err = GetLastError();

   if(code == -1)
   {
      string msg = "ERROR: WebRequest failed. Error=" + IntegerToString(err);
      if(err == 4060)
         msg += " | Add URL in Tools → Options → Expert Advisors → Allow WebRequest: " + NormalizeBaseUrl();
      else if(err == 4014)
         msg += " | WebRequest not permitted";
      else
         msg += " | Check network / URL / SSL. Base URL=" + NormalizeBaseUrl();
      LogErrorThrottled(msg);
      g_apiOk = false;
      g_loggedApiOk = false;
      return false;
   }

   outStatus = code;
   outBody = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(code < 200 || code >= 300)
   {
      LogErrorThrottled("ERROR: HTTP " + IntegerToString(code) + "  body=" + StringSubstr(outBody, 0, 200));
      g_apiOk = false;
      g_loggedApiOk = false;
      return false;
   }

   g_apiOk = true;
   return true;
}

//+------------------------------------------------------------------+
//| POST /api/ea/heartbeat                                           |
//+------------------------------------------------------------------+
bool PostHeartbeat(const double bid, const double ask, const double price)
{
   string url = NormalizeBaseUrl() + "/api/ea/heartbeat";
   string body = "{";
   body += "\"symbol\":\"" + EscapeJson(g_symbol) + "\",";
   body += "\"bid\":" + DoubleToString(bid, PriceDigits()) + ",";
   body += "\"ask\":" + DoubleToString(ask, PriceDigits()) + ",";
   body += "\"price\":" + DoubleToString(price, PriceDigits()) + ",";
   body += "\"timestamp\":\"" + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\"";
   body += "}";

   string resp;
   int status;
   if(!HttpRequest("POST", url, body, resp, status))
      return false;

   // Optionally read config_version from heartbeat response
   int ver = JsonGetInt(resp, "config_version", -1);
   if(ver >= 0 && ver != g_configVersion)
   {
      // Will refresh in FetchConfig
   }

   return true;
}

//+------------------------------------------------------------------+
//| GET /api/config                                                  |
//+------------------------------------------------------------------+
bool FetchConfig(const double currentPrice)
{
   string url = NormalizeBaseUrl() + "/api/config";
   string resp;
   int status;
   if(!HttpRequest("GET", url, "", resp, status))
   {
      LogErrorThrottled("ERROR: Invalid API response (config)");
      return false;
   }

   if(StringFind(resp, "\"alerts\"") < 0 && StringFind(resp, "version") < 0)
   {
      LogErrorThrottled("ERROR: JSON parse failed (config missing fields)");
      return false;
   }

   int version = JsonGetInt(resp, "version", -1);
   if(version < 0)
   {
      LogErrorThrottled("ERROR: JSON parse failed (version)");
      return false;
   }

   if(version == g_configVersion && g_alertCount >= 0 && g_configVersion >= 0)
   {
      // No change
      return true;
   }

   bool alertsEnabled = JsonGetBool(resp, "alerts_enabled", true);
   if(!alertsEnabled)
   {
      ResetAlerts();
      g_configVersion = version;
      Print(LOG_PREFIX, "Remote pause: alerts disabled");
      return true;
   }

   // Parse alerts array
   AlertState newAlerts[MAX_ALERTS];
   int newCount = 0;
   for(int i = 0; i < MAX_ALERTS; i++)
   {
      newAlerts[i].id = 0;
      newAlerts[i].price = 0.0;
      newAlerts[i].enabled = false;
      newAlerts[i].side = 0;
      newAlerts[i].valid = false;
   }

   int pos = StringFind(resp, "\"alerts\"");
   if(pos < 0)
   {
      LogErrorThrottled("ERROR: JSON parse failed (alerts)");
      return false;
   }

   int arrStart = StringFind(resp, "[", pos);
   int arrEnd   = FindMatchingBracket(resp, arrStart, '[', ']');
   if(arrStart < 0 || arrEnd < 0)
   {
      LogErrorThrottled("ERROR: JSON parse failed (alerts array)");
      return false;
   }

   string arr = StringSubstr(resp, arrStart + 1, arrEnd - arrStart - 1);
   // Split objects by '{...}'
   int search = 0;
   while(newCount < MAX_ALERTS)
   {
      int o1 = StringFind(arr, "{", search);
      if(o1 < 0) break;
      int o2 = FindMatchingBracket(arr, o1, '{', '}');
      if(o2 < 0) break;

      string obj = StringSubstr(arr, o1, o2 - o1 + 1);
      int id = JsonGetInt(obj, "id", 0);
      double price = JsonGetDouble(obj, "price", 0.0);
      bool enabled = JsonGetBool(obj, "enabled", true);

      if(id > 0 && price > 0.0)
      {
         newAlerts[newCount].id = id;
         newAlerts[newCount].price = price;
         newAlerts[newCount].enabled = enabled;
         newAlerts[newCount].valid = true;
         newAlerts[newCount].side = 0;

         // Preserve side if same id+price existed
         for(int k = 0; k < g_alertCount; k++)
         {
            if(g_alerts[k].valid && g_alerts[k].id == id &&
               MathAbs(g_alerts[k].price - price) < 1e-8)
            {
               newAlerts[newCount].side = g_alerts[k].side;
               break;
            }
         }
         newCount++;
      }
      search = o2 + 1;
   }

   // Apply
   for(int i = 0; i < MAX_ALERTS; i++)
      g_alerts[i] = newAlerts[i];
   g_alertCount = newCount;
   g_configVersion = version;

   // Init sides for new/unknown
   for(int i = 0; i < g_alertCount; i++)
   {
      if(g_alerts[i].side == 0 && currentPrice > 0.0)
      {
         if(currentPrice < g_alerts[i].price)
            g_alerts[i].side = -1;
         else if(currentPrice > g_alerts[i].price)
            g_alerts[i].side = 1;
      }
   }

   if(!g_loggedApiOk)
   {
      Print(LOG_PREFIX, "API connected");
      g_loggedApiOk = true;
   }
   Print(LOG_PREFIX, "Config version: ", g_configVersion);
   Print(LOG_PREFIX, "Loaded ", g_alertCount, " alerts");
   if(InpVerboseLog)
   {
      for(int i = 0; i < g_alertCount; i++)
         Print(LOG_PREFIX, "  Alert[", g_alerts[i].id, "] = ", FormatPrice(g_alerts[i].price));
   }

   return true;
}

//+------------------------------------------------------------------+
//| POST /api/alert-trigger                                          |
//+------------------------------------------------------------------+
bool SendTrigger(const int alertId, const double price, const double triggerPrice, const string direction)
{
   string url = NormalizeBaseUrl() + "/api/alert-trigger";
   string body = "{";
   body += "\"alert_id\":" + IntegerToString(alertId) + ",";
   body += "\"price\":" + DoubleToString(price, PriceDigits()) + ",";
   body += "\"trigger_price\":" + DoubleToString(triggerPrice, PriceDigits()) + ",";
   body += "\"direction\":\"" + direction + "\"";
   body += "}";

   string resp;
   int status;
   if(!HttpRequest("POST", url, body, resp, status))
   {
      Print(LOG_PREFIX, "ERROR: Trigger send failed");
      return false;
   }

   // Check skipped
   if(StringFind(resp, "\"skipped\":true") >= 0 || StringFind(resp, "\"skipped\": true") >= 0)
   {
      Print(LOG_PREFIX, "Trigger skipped by server (duplicate protection)");
      return true;
   }

   Print(LOG_PREFIX, "Trigger sent successfully");
   return true;
}

//+------------------------------------------------------------------+
//| Lightweight JSON helpers (no external libs)                      |
//+------------------------------------------------------------------+
string EscapeJson(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   return r;
}

int FindMatchingBracket(const string s, const int openPos, const ushort openCh, const ushort closeCh)
{
   if(openPos < 0 || openPos >= StringLen(s)) return -1;
   int depth = 0;
   bool inString = false;
   for(int i = openPos; i < StringLen(s); i++)
   {
      ushort ch = StringGetCharacter(s, i);
      if(ch == '"' )
      {
         // check escape
         int bs = 0;
         int j = i - 1;
         while(j >= 0 && StringGetCharacter(s, j) == '\\')
         {
            bs++;
            j--;
         }
         if((bs % 2) == 0)
            inString = !inString;
         continue;
      }
      if(inString) continue;
      if(ch == openCh) depth++;
      else if(ch == closeCh)
      {
         depth--;
         if(depth == 0) return i;
      }
   }
   return -1;
}

bool JsonFindKeyValue(const string json, const string key, string &valueOut)
{
   valueOut = "";
   string pattern = "\"" + key + "\"";
   int pos = StringFind(json, pattern);
   if(pos < 0) return false;

   int colon = StringFind(json, ":", pos + StringLen(pattern));
   if(colon < 0) return false;

   int i = colon + 1;
   int len = StringLen(json);
   // skip whitespace
   while(i < len)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == ' ' || c == '\n' || c == '\r' || c == '\t')
         i++;
      else
         break;
   }
   if(i >= len) return false;

   ushort first = StringGetCharacter(json, i);
   if(first == '"')
   {
      int end = i + 1;
      while(end < len)
      {
         ushort c = StringGetCharacter(json, end);
         if(c == '\\') { end += 2; continue; }
         if(c == '"') break;
         end++;
      }
      valueOut = StringSubstr(json, i + 1, end - i - 1);
      return true;
   }

   // number / bool / null
   int end2 = i;
   while(end2 < len)
   {
      ushort c = StringGetCharacter(json, end2);
      if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\n' || c == '\r' || c == '\t')
         break;
      end2++;
   }
   valueOut = StringSubstr(json, i, end2 - i);
   return true;
}

int JsonGetInt(const string json, const string key, const int defVal)
{
   string v;
   if(!JsonFindKeyValue(json, key, v)) return defVal;
   return (int)StringToInteger(v);
}

double JsonGetDouble(const string json, const string key, const double defVal)
{
   string v;
   if(!JsonFindKeyValue(json, key, v)) return defVal;
   return StringToDouble(v);
}

bool JsonGetBool(const string json, const string key, const bool defVal)
{
   string v;
   if(!JsonFindKeyValue(json, key, v)) return defVal;
   if(v == "true" || v == "1") return true;
   if(v == "false" || v == "0") return false;
   return defVal;
}
//+------------------------------------------------------------------+
