/*
 * RequestInterceptor.js
 *
 * Intercepts XMLHttpRequest request objects and tracking
 * beacons running in the page.
 */
class RequestInterceptor {

    /*
     * setupXHRInterception
     *
     * Starts the interception.
     */
    start() {
        this.setupXHRInterception();
        this.setupTrackingBeaconInterception();
    }

    /*
     * setupXHRInterception
     *
     * Setup detection of XHRs by replacing the definition of XMLHttpRequest's
     * methods with our own, and then calling the original implementation.
     * This allows us to setup an event just before a request phase
     * has completed.
     */
    setupXHRInterception() {
        // Store original XMLHttpRequest implementation so we can hook back
        // in after dispatching our events
        var send_imp = XMLHttpRequest.prototype.send,
            open_imp = XMLHttpRequest.prototype.open,
            setRequestHeader_imp = XMLHttpRequest.prototype.setRequestHeader;

        // Ensure we have a concrete reference to this instance, as `this`
        // changes context when you are in callbacks, etc
        var self = this;

        // Redefine XMLHttpRequest methods, in which we dispatch our
        // interception event, and then call the original implementation.
        XMLHttpRequest.prototype.send = function(data) {
            var requestBody = self.sanitizeBodyData(data);

            self.onIntercept({
                requestId: this.requestId,
                url: this.requestUrl,
                type: "XHR_send",
                props: {
                    requestBody: requestBody
                }
            });

            send_imp.apply(this, arguments);
        };

        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            // If the URL doesn't have any protocol/host info, then lets
            // get it from the window.location object. (origin is the
            // protocol + host/domain)
            var sanitizedUrl = self.sanitizeUrl(url);

            // Tag the request so we can follow it through the other
            // XHR methods
            this.requestId = guid();
            this.requestUrl = sanitizedUrl;

            // Create timeStamp on open() so we get the timestamp of the
            // request, not the complete
            // TODO: Verify this is correct behaviour?
            var timeStamp = new Date().getTime();

            // Add a readystatechange listener when we detect an XHR so we can
            // detect when we have a response
            this.addEventListener('readystatechange', function(event) {
                var success = this.status.isSuccessfulStatusCode();
                var finished = this.readyState === XMLHttpRequest.DONE;

                // Ignore if we haven't completed successfully.
                if (!(success && finished)) {
                    return;
                }

                var responseBody = self.sanitizeBodyData(this.response);

                self.onIntercept({
                    requestId: this.requestId,
                    url: this.requestUrl,
                    type: "XHR_complete",
                    props: {
                        url: sanitizedUrl,
                        method: method,
                        timeStamp: timeStamp,
                        statusCode: this.status,
                        responseHeaders: getHeaderDictionary(this.getAllResponseHeaders()),
                        responseBody: responseBody
                    }
                });
            });

            // Add an error listener so we can clear out the request
            this.addEventListener('error', function(event) {
                self.onIntercept({
                    requestId: this.requestId,
                    url: this.requestUrl,
                    type: "XHR_error",
                    props: {}
                });
            });

            self.onIntercept({
                requestId: this.requestId,
                url: this.requestUrl,
                type: "XHR_open",
                props: {}
            });

            open_imp.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
            self.onIntercept({
                requestId: this.requestId,
                url: this.requestUrl,
                type: "XHR_setRequestHeader",
                props: {
                    requestHeader: { name: header, value: value }
                }
            });

            setRequestHeader_imp.apply(this, arguments);
        };
    }

    /*
     * setupTrackingBeaconInterception
     *
     * Detect JS Image object loads, which are commonly used for loading
     * tracking pixels/beacons.
     */
    setupTrackingBeaconInterception() {
        // Store original descriptor for "src" property.
        //
        // NOTE: HTMLImageElement is the underlying class for an Image object,
        // so we're targeting that one. Targeting the Image object doesn't
        // work in some browsers.
        var src_imp = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");

        // Ensure we have a concrete reference to this instance, as `this`
        // changes context when you are in callbacks, etc
        var self = this;

        // Define a new implementation for the "src" property, send our event
        // if we need to, then call the original implementation
        Object.defineProperty(HTMLImageElement.prototype, "src", {
            get() {
                return src_imp.get.call(this);
            },
            set(value) {
                // Facebook images do not load if we call onIntercept directly, so we need a short delay
                setTimeout(function() {
                    self.onIntercept({
                        requestId: guid(),
                        url: self.sanitizeUrl(value),
                        type: "tracking_src",
                        props: {
                            timeStamp: new Date().getTime(),
                            url: self.sanitizeUrl(value),
                            method: "GET"
                        }
                    });
                }, 1);                

                return src_imp.set.call(this, value);
            }
        });
    }

    /*
     * onIntercept
     *
     * Called when an interceptor has triggered. Dispatches a DOM event
     * with the interception details.
     */
    onIntercept(details) {
        // NOTE: If you want to send a data object with the event, it has to
        // be wrapped in another object as the "detail" property.
        var event = new CustomEvent("onRequestInterception", {
            detail: { requestDetails: details }
        });

        // Dispatch it to the window object so everybody can register for
        // the event
        window.dispatchEvent(event);
    }

    /*
     * sanitizeUrl
     *
     * This is to fill in the gaps when a browser requests a URL starting
     * with only a slash or a double-slash. Also, try and do some sort of
	 * conversion on Facebook URI objects. If all else fails, just toString()
	 * whatever we have.
     */
    sanitizeUrl(url) {
		if (typeof url === "string") {
	        if (url.startsWith("//")) {
	            return window.location.protocol + url;
	        } else if (url.startsWith("/")) {
	            return window.location.origin + url;
	        } else {
	            return url;
	        }
		} else if (url.domain && url.protocol && url.path) {
			return url.protocol + "://" + url.domain + url.path;
		} else {
			return url.toString();
		}
    }

    /*
     * sanitizeBodyData
     *
     * Request and response bodies can literally be anything. Some data types
     * cannot be serialized (such as FormData), and thus are unable to be
     * passed around in extension messages and DOM events, which this extension
     * heavily relies on. We're going to attempt to serialize the data to
     * string here, so we can pass it around freely.
     *
     * WARNING: Not pretty
     */
    sanitizeBodyData(body) {
        if (!body) {
            return null;
        }

        // Everything apart from a Blob object are actually "subclasses" of
        // TypedArray/ArrayBufferView, but the subclass isn't exposed to us,
        // meaning the only way to check for them is like this.
        var isBinary =
            body instanceof Blob ||
            body instanceof Int8Array ||
            body instanceof Uint8Array ||
            body instanceof Uint8ClampedArray ||
            body instanceof Int16Array ||
            body instanceof Uint16Array ||
            body instanceof Int32Array ||
            body instanceof Uint32Array ||
            body instanceof Float32Array ||
            body instanceof Float64Array;

        if (body instanceof FormData) {
            // Make a rudimentary query-string from the form data
            var keys = Array.from(body.keys());
            return keys.map(function(key) {
                return key + "=" + body.get(key);
            }).join("&");
        } else if (body instanceof Document) {
            // A Document object can be HTML, XML, SVG, basically anything
            // XML-based with the looks of it. We can convert this to string
            // pretty easily.
            return body.documentElement.innerHTML;
        } else if (isBinary) {
            // What to do if we get binary data? It requires a FileReader
            // object to convert to string, which is async.
            // TODO: Implement something a bit better than this.
            return null;
        } else if (typeof body === "string") {
            // Simply return the body if we have a string coming through
            return body;
        } else if (isObject(body)) {
            // If we see an object, attempt to convert to JSON.
            try {
                return JSON.stringify(body);
            }
            catch (ex) {
                return null;
            }
        } else {
            // Shouldn't be able to get here I guess, but you know,
            // anything's possible.
            return null;
        }
    }
}

/*
 * Number.isSuccessfulStatusCode
 *
 * We may lose some successful requests by only checking for 200, as anything
 * in the 2xx range is considered "successful".
 */
Number.prototype.isSuccessfulStatusCode = function() {
    return this >= 200 && this < 300;
}

/*
 * getHeaderDictionary
 *
 * Converts a CRLF-delimited string of headers to a dictionary
 */
function getHeaderDictionary(headerString) {
    // Use reduce() instead of map() so we can ignore a header if for whatever
    // reason header.length != 2. (using map() requires every element to
    // return something)
    return headerString.split("\r\n").reduce(function(acc, current) {
        var header = current.split(":");

        if (header.length === 2) {
            var key = header[0].trim(), value = header[1].trim();
            acc.push({ name: key, value: value });
        }

        return acc;
    }, []);
}

/*
 * guid
 *
 * Generates a GUID to tag requests with
 */
function guid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/*
 * isObject
 *
 * Determines whether `item` is a JS object, i.e. `{}`.
 */
function isObject(item) {
    return typeof item === "object" && !Array.isArray(item) && item !== null;
}

// Kick off the interception
new RequestInterceptor().start();
