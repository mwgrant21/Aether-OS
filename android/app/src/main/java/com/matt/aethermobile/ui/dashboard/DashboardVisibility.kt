package com.matt.aethermobile.ui.dashboard

/** True when the core slot [coreTop]..[coreBottom] overlaps the viewport [viewTop]..[viewBottom], all in one coordinate space. An empty or not-yet-laid-out slot (zero height) is not visible. */
fun coreOnScreen(coreTop: Float, coreBottom: Float, viewTop: Float, viewBottom: Float): Boolean =
    coreBottom > coreTop && coreBottom > viewTop && coreTop < viewBottom
