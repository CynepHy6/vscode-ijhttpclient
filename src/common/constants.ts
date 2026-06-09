export const LineSplitterRegex: RegExp = /\r?\n/g;
export const DelimiterLineRegex: RegExp = /^\s*#{3,}.*$/;
export const CommentLineRegex: RegExp = /^\s*(#|\/{2}).*$/;
export const MetadataLineRegex: RegExp =
    /^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s*(?:=)?\s*(.*?))?\s*$/;
export const PromptCommentRegex: RegExp =
    /^\s*(?:#{1,}|\/\/+)\s*@prompt\s+([^\s]+)(?:\s+(.*))?\s*$/i;
export const VariableReferenceRegex: RegExp = /\{\{([^{}]+)\}\}/g;
export const FileVariableDefinitionRegex: RegExp =
    /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/;
export const ResponseStatusLineRegex: RegExp = /^\s*HTTP\/[\d.]+\s+\d{3}\b/;
export const RequestLineRegex: RegExp =
    /^(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE|LOCK|UNLOCK|PROPFIND|PROPPATCH|COPY|MOVE|MKCOL|MKCALENDAR|ACL|SEARCH|BIND|REBIND|UNBIND|LINK|UNLINK|MERGE|PURGE|REPORT|MKACTIVITY|CHECKOUT|MSEARCH|NOTIFY|SUBSCRIBE|UNSUBSCRIBE)\s+)?(?:https?:\/\/|wss?:\/\/|{{|[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]).*$/i;
export const HeaderLineRegex: RegExp = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*:\s*.*$/;
export const ScriptStartRegex: RegExp = /^\s*[<>]\s*{\%\s*$/;
export const ScriptInlineRegex: RegExp = /^\s*[<>]\s*{\%[\s\S]*\%}\s*$/;
export const ScriptCloseRegex: RegExp = /^\s*\%}\s*$/;
export const ResponseRedirectRegex: RegExp = /^\s*>>!?(\s+.+)?$/;
export const HistoryCommentLineRegex: RegExp = /^\s*#\s*<>\s*(\S+)\s*$/;

export const PublicEnvironmentFileName = "http-client.env.json";
export const PrivateEnvironmentFileName = "http-client.private.env.json";
