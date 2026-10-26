package com.matt.aethermobile.ui.thread

/**
 * Minimal markdown for assistant text: fenced code blocks, inline `code` and **bold**.
 * Nothing else is interpreted: links, images and HTML stay literal text. Pure JVM,
 * linear time: every scan either consumes input or is skipped once it has failed.
 */
object MarkdownLite {
    enum class Style { PLAIN, BOLD, CODE }

    data class Span(val text: String, val style: Style)

    sealed class Block {
        data class Paragraph(val spans: List<Span>) : Block()
        data class CodeFence(val code: String) : Block()
    }

    fun parse(input: String): List<Block> {
        val blocks = ArrayList<Block>()
        val para = ArrayList<String>()
        val code = ArrayList<String>()
        var inFence = false

        fun flushPara() {
            if (para.isNotEmpty()) {
                blocks.add(Block.Paragraph(inline(para.joinToString("\n"))))
                para.clear()
            }
        }

        for (raw in input.split('\n')) {
            val line = raw.trimEnd('\r')
            if (inFence) {
                if (isFenceClose(line)) {
                    blocks.add(Block.CodeFence(code.joinToString("\n")))
                    code.clear()
                    inFence = false
                } else {
                    code.add(line)
                }
            } else if (line.trimStart().startsWith("```")) {
                flushPara()
                inFence = true
            } else if (line.isBlank()) {
                flushPara()
            } else {
                para.add(line)
            }
        }
        // An unterminated fence closes at end of input.
        if (inFence) blocks.add(Block.CodeFence(code.joinToString("\n")))
        flushPara()
        return blocks
    }

    private fun isFenceClose(line: String): Boolean {
        val t = line.trim()
        return t.length >= 3 && t.all { it == '`' }
    }

    private fun inline(s: String): List<Span> {
        val spans = ArrayList<Span>()
        val plain = StringBuilder()
        // Once a delimiter has no closer, no later one can have one either.
        var noMoreTick = false
        var noMoreBold = false

        fun flushPlain() {
            if (plain.isNotEmpty()) {
                spans.add(Span(plain.toString(), Style.PLAIN))
                plain.setLength(0)
            }
        }

        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '`' && !noMoreTick) {
                val end = s.indexOf('`', i + 1)
                if (end < 0) {
                    noMoreTick = true
                } else if (end > i + 1) {
                    flushPlain()
                    spans.add(Span(s.substring(i + 1, end), Style.CODE))
                    i = end + 1
                    continue
                }
            } else if (c == '*' && !noMoreBold && s.startsWith("**", i)) {
                val end = s.indexOf("**", i + 2)
                if (end < 0) {
                    noMoreBold = true
                } else if (end > i + 2) {
                    flushPlain()
                    spans.add(Span(s.substring(i + 2, end), Style.BOLD))
                    i = end + 2
                    continue
                }
            }
            plain.append(c)
            i++
        }
        flushPlain()
        return spans
    }
}
