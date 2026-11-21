// Adds MarketMind's native extras to the Android project that `npx cap add android` creates:
// the home-screen widget (Java + layouts), the notification icon, and the manifest entries for both.
import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const main = 'android/app/src/main';
cpSync('native/java', `${main}/java`, { recursive: true });
cpSync('native/res', `${main}/res`, { recursive: true });

const mf = `${main}/AndroidManifest.xml`;
let x = readFileSync(mf, 'utf8');
if (!x.includes('android.permission.POST_NOTIFICATIONS'))
  x = x.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
if (!x.includes('.IndexWidget')) {
  x = x.replace('</application>', `
        <receiver android:name=".IndexWidget" android:exported="false" android:label="MarketMind indices">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
                <action android:name="in.org.kuhu.marketmind.WIDGET_REFRESH" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/index_widget_info" />
        </receiver>
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_mm" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/w_accent" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="market" />
    </application>`);
}
writeFileSync(mf, x);
console.log('Patched manifest; widget receiver', x.includes('.IndexWidget') ? 'added' : 'MISSING');
if (!existsSync(`${main}/java/in/org/kuhu/marketmind/IndexWidget.java`)) { console.error('IndexWidget.java was not copied'); process.exit(1); }
