package in.org.kuhu.marketmind;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Home-screen widget: NIFTY 50, Bank NIFTY, SENSEX and India VIX from marketmind.kuhu.org.in/api/widget.php. */
public class IndexWidget extends AppWidgetProvider {
    static final String URL_DATA = "https://marketmind.kuhu.org.in/api/widget.php";
    static final String ACTION_REFRESH = "in.org.kuhu.marketmind.WIDGET_REFRESH";
    static final String PREFS = "mm_widget";
    static final int[][] IDS = {
        {R.id.w_n1, R.id.w_v1, R.id.w_c1}, {R.id.w_n2, R.id.w_v2, R.id.w_c2},
        {R.id.w_n3, R.id.w_v3, R.id.w_c3}, {R.id.w_n4, R.id.w_v4, R.id.w_c4}
    };

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        draw(ctx, mgr, ids, cached(ctx), true);
        fetch(ctx, goAsync());
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            draw(ctx, mgr, allIds(ctx, mgr), cached(ctx), true);
            fetch(ctx, goAsync());
        }
    }

    static int[] allIds(Context ctx, AppWidgetManager mgr) {
        return mgr.getAppWidgetIds(new ComponentName(ctx, IndexWidget.class));
    }

    static String cached(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("json", null);
    }

    static void fetch(final Context ctx, final PendingResult pr) {
        new Thread(() -> {
            String json = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(URL_DATA).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "MarketMindApp widget");
                if (c.getResponseCode() == 200) {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                        String line;
                        while ((line = r.readLine()) != null) sb.append(line);
                    }
                    json = sb.toString();
                    new JSONObject(json); // check it parses
                    SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
                    e.putString("json", json).apply();
                }
                c.disconnect();
            } catch (Exception ignored) {
                json = null;
            }
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            draw(ctx, mgr, allIds(ctx, mgr), json != null ? json : cached(ctx), false);
            if (pr != null) pr.finish();
        }).start();
    }

    static String fmt(double v) {
        return String.format(Locale.ENGLISH, v >= 1000 ? "%,.0f" : "%,.2f", v);
    }

    static void draw(Context ctx, AppWidgetManager mgr, int[] ids, String json, boolean loading) {
        boolean night = (ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int up = night ? 0xFF3DD68C : 0xFF15803D, down = night ? 0xFFFF8A5B : 0xFFC2410C, muted = night ? 0xFF9DAAB8 : 0xFF6B7785;
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_indices);
            Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (open != null) v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            Intent rf = new Intent(ctx, IndexWidget.class).setAction(ACTION_REFRESH);
            v.setOnClickPendingIntent(R.id.w_refresh, PendingIntent.getBroadcast(ctx, 1, rf, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            String status = loading ? "Updating…" : "No connection";
            try {
                if (json != null) {
                    JSONObject o = new JSONObject(json);
                    JSONArray rows = o.getJSONArray("rows");
                    for (int i = 0; i < IDS.length && i < rows.length(); i++) {
                        JSONObject r = rows.getJSONObject(i);
                        v.setTextViewText(IDS[i][0], r.optString("name"));
                        if (r.isNull("last")) {
                            v.setTextViewText(IDS[i][1], "—");
                            v.setTextViewText(IDS[i][2], "");
                            continue;
                        }
                        v.setTextViewText(IDS[i][1], fmt(r.getDouble("last")));
                        if (!r.isNull("pct")) {
                            double p = r.getDouble("pct");
                            boolean vix = r.optString("name").contains("VIX");
                            v.setTextViewText(IDS[i][2], String.format(Locale.ENGLISH, "%s%.2f%%", p > 0 ? "▲ " : p < 0 ? "▼ " : "", Math.abs(p)));
                            v.setTextColor(IDS[i][2], p == 0 ? muted : ((p > 0) != vix ? up : down));
                        } else v.setTextViewText(IDS[i][2], "");
                    }
                    SimpleDateFormat f = new SimpleDateFormat("h:mm a", Locale.ENGLISH);
                    f.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
                    String t = f.format(new Date(o.optLong("at", System.currentTimeMillis() / 1000) * 1000L));
                    status = (loading ? "Updating… " : "") + (o.optBoolean("open") ? "Market open · " : "Market closed · ") + t;
                }
            } catch (Exception ignored) { /* keep the old text */ }
            v.setTextViewText(R.id.w_status, status);
            mgr.updateAppWidget(id, v);
        }
    }
}
