package com.flick.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Shown instead of Flick's screen once after Flick closed unexpectedly: what happened (CrashReport), to copy and send
 * to whoever looks after Flick. Plain Android views: nothing here depends on the parts that may have crashed.
 */
public class CrashActivity extends Activity {
    static final String EXTRA = "report";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        final String report = String.valueOf(getIntent().getStringExtra(EXTRA));
        int dp = (int) getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF120F19);
        root.setPadding(20 * dp, 24 * dp, 20 * dp, 16 * dp);

        TextView title = new TextView(this);
        title.setText("Flick closed unexpectedly");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("This is what went wrong. Tap Copy and send it to whoever looks after Flick, so it can be fixed.");
        sub.setTextColor(0xCCFFFFFF);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        sub.setPadding(0, 8 * dp, 0, 12 * dp);
        root.addView(sub);

        ScrollView sv = new ScrollView(this);
        TextView body = new TextView(this);
        body.setText(report);
        body.setTextColor(0xFFE6E6E6);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        body.setBackgroundColor(0xFF1E1A27);
        body.setPadding(10 * dp, 10 * dp, 10 * dp, 10 * dp);
        sv.addView(body);
        root.addView(sv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, 12 * dp, 0, 0);
        Button copy = new Button(this);
        copy.setText("Copy");
        copy.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("Flick crash report", report));
                    Toast.makeText(CrashActivity.this, "Copied", Toast.LENGTH_SHORT).show();
                } catch (Throwable e) { Toast.makeText(CrashActivity.this, "Couldn't copy", Toast.LENGTH_SHORT).show(); }
            }
        });
        Button open = new Button(this);
        open.setText("Open Flick");
        open.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(CrashActivity.this, MainActivity.class));
                finish();
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(copy, lp);
        row.addView(open, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(row);
        setContentView(root);
    }
}
