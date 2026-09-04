import Foundation

/// URLSession for 127.0.0.1 / localhost. An empty proxy dictionary opts out of
/// the system SOCKS/HTTP proxy, which otherwise intercepts loopback.
enum YishuLoopbackSession {
    static func configuration(
        from base: URLSessionConfiguration = .default
    ) -> URLSessionConfiguration {
        let configuration = (base.copy() as? URLSessionConfiguration)
            ?? URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        return configuration
    }

    static func make(
        from base: URLSessionConfiguration = .default,
        delegate: URLSessionDelegate? = nil,
        delegateQueue: OperationQueue? = nil
    ) -> URLSession {
        URLSession(
            configuration: configuration(from: base),
            delegate: delegate,
            delegateQueue: delegateQueue
        )
    }
}
