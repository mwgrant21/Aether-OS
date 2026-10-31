package com.matt.aethermobile.ui.shell

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.matt.aethermobile.R
import com.matt.aethermobile.net.ControlClient
import com.matt.aethermobile.projects.ProjectsWire
import com.matt.aethermobile.protocol.ControlProtocol
import com.matt.aethermobile.ui.projects.ProjectsScreen
import com.matt.aethermobile.views.ViewHost
import com.matt.aethermobile.views.ViewUi
import org.json.JSONObject

/** The JVM-testable half of a pane: which view id it reads and how its payload decodes. */
class PaneSpec<T : Any>(val appView: AppView, val viewId: String, val decode: (JSONObject) -> T?)

/** One registered pane: its [spec], burger strings and screen. Adding a pane means adding one entry to [PaneRegistry.entries]. */
class PaneEntry<T : Any>(
    val spec: PaneSpec<T>,
    @StringRes val label: Int,
    @StringRes val description: Int,
    val content: @Composable (ViewUi<T>, Long, Modifier) -> Unit,
) {
    @Suppress("UNCHECKED_CAST")
    @Composable
    fun render(ui: ViewUi<*>, nowMs: Long, modifier: Modifier) = content(ui as ViewUi<T>, nowMs, modifier)
}

object PaneRegistry {
    /** One entry per registered pane; the burger row, title, body and lock-drop all derive from this list. */
    val entries: List<PaneEntry<*>> = listOf(
        PaneEntry(
            PaneSpec(AppView.PROJECTS, "projects", ProjectsWire::decode),
            R.string.view_projects, R.string.view_projects_desc,
        ) { ui, now, mod -> ProjectsScreen(ui, now, mod) },
    )

    fun entry(app: AppView): PaneEntry<*>? = entries.firstOrNull { it.spec.appView == app }
}

/**
 * One [ViewHost] per registered pane for one connection. Each host's `supported` is wired to
 * [ControlClient.supportsView] of the CURRENT client, so a titan whose welcome lacks `views` shows the pane
 * Unsupported and never receives a view.attach. Main thread except [onFrame] (transport thread, hosts are synchronized).
 */
class PaneHosts(
    private val specs: List<PaneSpec<*>>,
    private val client: () -> ControlClient?,
    private val onChanged: () -> Unit = {},
) {
    private val hosts: Map<AppView, ViewHost<Any>> = specs.associate { spec ->
        @Suppress("UNCHECKED_CAST")
        val decode = spec.decode as (JSONObject) -> Any?
        spec.appView to ViewHost<Any>(
            viewId = spec.viewId,
            decode = decode,
            supported = { client()?.supportsView(spec.viewId) == true },
            sendAttach = { client()?.viewAttach(spec.viewId) ?: false },
            sendDetach = { client()?.viewDetach(spec.viewId) ?: false },
            onChanged = onChanged,
        )
    }

    /** Attach exactly the open pane, and only on a welcomed connection ([live]). Detaches the rest. */
    fun sync(live: Boolean, open: AppView) {
        for ((app, h) in hosts) {
            if (live) h.onConnected()
            h.activate(live && open == app)
        }
    }

    fun onFrame(f: ControlProtocol.ViewFrame) {
        for (h in hosts.values) h.onFrame(f)
    }

    /** Lock, relock or error: detach while the socket may still be up, then drop the data. */
    fun drop() {
        for (h in hosts.values) { h.activate(false); h.onDisconnected() }
    }

    fun snapshots(): Map<AppView, ViewUi<Any>> = hosts.mapValues { it.value.snapshot() }
}
